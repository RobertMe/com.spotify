'use strict';

const Homey = require('homey');
const logger = require('homey-log').Log;

const SpotifyWebApi = require('./lib/spotify-web-api-node');
const Queue = require('promise-queue');

const UPDATE_STATE_TIMEOUT = 30000;
const PLAYLIST_REFRESH_TIMEOUT = 24 * 60 * 60 * 1000;
const THROTTLE_TIMEOUT = 500;
const MAX_RETRY_TIMEOUT = 300000;
const AUTH_RETRY_TIMEOUT = 10000;
let RETRY_TIMEOUT = 5000;
let retryTimeout;
let retryCount = 0;

const scopes = [
	'user-read-private',
	'playlist-read-collaborative',
	'playlist-read-private',
	'user-top-read',
	'user-read-email',
	'user-read-playback-state',
	'user-modify-playback-state',
];
const state = 'homey-spotify';
let market;
switch (Homey.ManagerI18n.getLanguage()) {
	case 'en':
		market = 'GB';
		break;
	case 'nl':
		market = 'NL';
		break;
	case 'de':
		market = 'DE';
		break;
}

module.exports = class App extends Homey.App {

	/**
	 * Initialize the Spotify app with the necessary information:
	 * - client ID
	 * - client secret
	 *
	 * Once initialised respond to search, play and playlist request
	 * from the Homey Media Manager.
	 */
	onInit() {
		this.queue = new Queue(1, Infinity);
		this.playListOwnerMap = new Map();

		this.spotifyApi = new SpotifyWebApi({
			clientId: Homey.env.CLIENT_ID,
			clientSecret: Homey.env.CLIENT_SECRET,
			redirectUri: Homey.env.REDIRECT_URI,
		});

		/*
		 * Initialize the Spotify client with a previously obtained accessToken whenever possible.
		 */
		Homey.ManagerSettings.set('authorized', false);
		Homey.ManagerApi.realtime('authorized', false);
		this.emit('authenticated', false);

		// Set Authentication retry counter.
		this.authRetries = 0;
		this.on('authenticated', (isAuthenticated) => {
			if (isAuthenticated) {
				this.authRetries = 0;
			}
		});

		this.authorizeSpotify()
			.catch(this.error);

		new Homey.FlowCardCondition('spotify_is_playing')
			.register()
			.registerRunListener(() =>
				this.queue.add(() => this.spotifyApi.getMyCurrentPlaybackState())
					.then(result => result.body.is_playing)
			);

		new Homey.FlowCardAction('spotify_play')
			.register()
			.registerRunListener(() =>
				this.queue.add(() => this.spotifyApi.startMyPlayback({}))
			);

		new Homey.FlowCardAction('spotify_pause')
			.register()
			.registerRunListener(() =>
				this.queue.add(() => this.spotifyApi.pauseMyPlayback({}))
			);

		new Homey.FlowCardAction('spotify_next')
			.register()
			.registerRunListener(() =>
				this.queue.add(() => this.spotifyApi.skipMyPlaybackNext({}))
			);

		new Homey.FlowCardAction('spotify_previous')
			.register()
			.registerRunListener(() =>
				this.queue.add(() => this.spotifyApi.skipMyPlaybackPrevious({}))
			);

		/*
		 * Respond to a search request by returning an array of parsed search results
		 */
		Homey.ManagerMedia.on('search', (queryObject, callback) => {
			if (!Homey.ManagerSettings.get('authorized')) {
				return callback(new Error(Homey.__('error.not_authorized')));
			}
			/*
			 * Execute a search using the Spotify client.
			 * Since we are only interested in streamable results we apply filters.
			 */
			this.spotifyApi.searchTracks(queryObject.searchQuery, { limit: 5, market })
				.then((data) => callback(null, this.parseTracks(data.body.tracks.items)))
				.catch(callback);
		});

		/*
		 * Respond to a play request by returning a parsed track object.
		 * The request object contains a trackId and a format property to indicate what specific
		 * resource and in what format is wanted for playback.
		 */
		Homey.ManagerMedia.on('play', (request, callback) => {
			if (!Homey.ManagerSettings.get('authorized')) {
				return callback(new Error(Homey.__('error.not_authorized')));
			}
			callback(null, { stream_url: request.trackId });
		});

		/*
		 * Homey can periodically request static playlist that are available through
		 * the streaming API (when applicable)
		 */
		Homey.ManagerMedia.on('getPlaylists', (callback) => {
			clearTimeout(retryTimeout);
			clearTimeout(this.playlistRefreshTimeout);
			this.playlistRefreshTimeout = setTimeout(
				() => Homey.ManagerMedia.requestPlaylistsUpdate(),
				((Math.random() - 1) * (PLAYLIST_REFRESH_TIMEOUT / 24)) + PLAYLIST_REFRESH_TIMEOUT // Set refresh timeout with some variance (+- 30 minutes)
			);
			if (!Homey.ManagerSettings.get('authorized')) {
				return callback(null, []);
			}
			this.getPlayLists()
				.then(playLists => {
					retryCount = 0;
					callback(null, playLists);
				})
				.catch(err => {
					this.error('got playlists err', err);
					retryCount++;
					retryTimeout = setTimeout(() => Homey.ManagerMedia.requestPlaylistsUpdate(), RETRY_TIMEOUT);
					RETRY_TIMEOUT = Math.min(RETRY_TIMEOUT * 2, MAX_RETRY_TIMEOUT);
					callback(err);
				});
		});

		/*
		 * Homey might request a specific playlist so it can be refreshed
		 */
		Homey.ManagerMedia.on('getPlaylist', (request, callback) => {
			if (!Homey.ManagerSettings.get('authorized')) {
				return callback(new Error(Homey.__('error.not_authorized')));
			}
			this.getPlayList(request.playlistId)
				.then(playList => {
					callback(null, playList);
				})
				.catch(callback);
		});

		/**
		 * Set update_state event on interval to bundle state updates for all devices at once
		 */
		this.UPDATE_STATE_TIMEOUT = UPDATE_STATE_TIMEOUT;
		setInterval(this.emit.bind(this, 'update_state'), UPDATE_STATE_TIMEOUT);
	}

	getPlaylistOwner(id) {
		return this.playListOwnerMap.get(id);
	}

	setPlaylistOwner(playlistId, ownerId) {
		return this.playListOwnerMap.set(playlistId, ownerId);
	}

	getPlayLists() {
		return this.getPlayListsRecursive()
			.then(items => {
				return Promise.all(
					items.map(playlist => {
						this.setPlaylistOwner(playlist.id, playlist.owner.id);
						return this.getPlayList(playlist.id);
						// TODO: enable when getPlaylists accepts empty playlists and requests the playlists one by one
						// return {
						// 	type: 'playlist',
						// 	id: playlist.id,
						// 	title: playlist.name,
						// };
					})
				);
			});
	}

	getPlayList(id) {
		return Promise.all([
			this.queue.add(() => this.spotifyApi.getPlaylist(this.getPlaylistOwner(id), id)),
			this.getPlayListEntriesRecursive(this.getPlaylistOwner(id), id),
		]).then(data => ({
			type: 'playlist',
			id: data[0].body.id,
			title: data[0].body.name,
			tracks: data[1],
		}));
	}

	getPlayListsRecursive(offset) {
		return this.queue.add(() => this.spotifyApi.getUserPlaylists(null, { limit: 50, offset })
			.then(data => new Promise(r => setTimeout(() => r(data), retryCount * THROTTLE_TIMEOUT + THROTTLE_TIMEOUT)))
		).then((data) => {
			if (data.body.next) {
				return this.getPlayListsRecursive(data.body.offset + data.body.limit)
					.then(nextData => {
						return data.body.items.concat(nextData);
					});
			}
			return data.body.items;
		});
	}

	getPlayListEntriesRecursive(ownerId, playListId, offset) {
		return this.queue.add(() => this.spotifyApi.getPlaylistTracks(ownerId, playListId, { limit: 100, offset })
			.then(data => new Promise(r => setTimeout(() => r(data), retryCount * THROTTLE_TIMEOUT + THROTTLE_TIMEOUT)))
		).then(data => {
			const items = this.parseTracks(data.body.items.map(item => item.track));
			if (data.body.next) {
				return this.getPlayListEntriesRecursive(ownerId, playListId, data.body.offset + data.body.limit)
					.then(nextItems => items.concat(nextItems));
			}
			return items;
		});
	}

	/* ====================================================== */

	/**
	 * Initiates OAuth for this media app, this is needed when retrieving information specific to a service account.
	 * Some user content might only be available when the user is authenticated.
	 *
	 * @param callback
	 */
	startOAuth2(callback) {
		new Homey.CloudOAuth2Callback(
			// if the external oauth server requires an Authorization callback URL set it to https://callback.athom.com/oauth2/callback/
			// this is the app-specific authorize url
			this.spotifyApi.createAuthorizeURL(scopes, state, true)
		)
			.on('url', url => callback(null, url))
			.on('code', code => this.authorizeSpotify({ code }).then(() => Homey.ManagerMedia.requestPlaylistsUpdate()))
			.generate()
			.catch(this.error);
	}

	authorizeSpotify(credentials) {

		if (!credentials) {
			credentials = {
				accessToken: Homey.ManagerSettings.get('accessToken'),
				refreshToken: Homey.ManagerSettings.get('refreshToken'),
			};
		}

		clearTimeout(this.authRetryTimeout);
		clearTimeout(this.authorizationRefreshTimeout);

		const setAuthorized = (accessToken, refreshToken, expiresIn) => {
			// set access and refresh tokens
			this.spotifyApi.setAccessToken(accessToken);
			Homey.ManagerSettings.set('accessToken', accessToken);
			if (refreshToken) {
				this.spotifyApi.setRefreshToken(refreshToken);
				Homey.ManagerSettings.set('refreshToken', refreshToken);
			}

			Homey.ManagerSettings.set('authorized', true);
			Homey.ManagerApi.realtime('authorized', true);
			this.emit('authenticated', true);
			this.authenticated = true;

			Homey.ManagerMedia.requestPlaylistsUpdate();

			this.authorizationRefreshTimeout = setTimeout(this.authorizeSpotify.bind(this), (expiresIn - 600) * 1000);

			this.log('new credentials', this.spotifyApi.getCredentials());
		};

		if (credentials.code) {
			return this.spotifyApi.authorizationCodeGrant(credentials.code)
				.then(data => {
					this.log('authorized', data);

					return setAuthorized(data.body.access_token, data.body.refresh_token, data.body.expires_in);
				});
		} else if (credentials.accessToken && credentials.refreshToken) {
			this.spotifyApi.setAccessToken(credentials.accessToken);
			this.spotifyApi.setRefreshToken(credentials.refreshToken);
			return this.spotifyApi.refreshAccessToken()
				.then(data => {
					this.log('authorized', data);

					return setAuthorized(data.body.access_token, data.body.refresh_token, data.body.expires_in);
				})
				.catch(err => {
					if (!this.authRetries || this.authRetries < 5) {
						this.authRetries = (this.authRetries || 0) + 1;
						return new Promise(res =>
							this.authRetryTimeout = setTimeout(
								() => res(this.authorizeSpotify(credentials)),
								AUTH_RETRY_TIMEOUT * Math.pow(2, this.authRetries - 1)
							)
						);
					}
					return Promise.reject(err);
				});
		} else {
			this.log('no credentials', credentials);
			return Promise.reject(new Error(Homey.__('error.invalid_credentials')));
		}
	}

	/**
	 * We deauthorize this media app to use the account specific information
	 * it once had access to by resetting our token and notifying Homey Media
	 * the new status.
	 * @param callback
	 */
	deauthorize(callback) {
		Homey.ManagerSettings.unset('accessToken');
		Homey.ManagerSettings.unset('refreshToken');
		Homey.ManagerSettings.set('authorized', false);
		Homey.ManagerApi.realtime('authorized', false);
		this.emit('authenticated', false);

		clearTimeout(this.authorizationRefreshTimeout);

		this.spotifyApi.resetAccessToken();
		this.spotifyApi.resetRefreshToken();

		Homey.ManagerMedia.requestPlaylistsUpdate();

		return callback();
	}

	/**
	 * Fetches the user profile of the authenticated user.
	 *
	 * @param callback
	 */
	getProfile(callback) {
		if (!this.isAuthenticated()) {
			return callback(new Error('could not fetch profile, user is not authenticated'));
		}

		this.queue.add(() => this.spotifyApi.getMe())
			.then(data => callback(null, data.body))
			.catch(callback);
	}

	isAuthenticated() {
		return Homey.ManagerSettings.get('authorized') && this.spotifyApi.getCredentials().refreshToken;
	}

	getApi() {
		return this.spotifyApi;
	}

	/* ====================================================== */

	/**
	 * Parses a raw track into a Homey readable format.
	 * Note that the format is slightly different for search queries and play requests.
	 *
	 * - The search format comes with a confidence property ranging between 0 and 1.0
	 *   that indicates how strong of a match the parsed Track is to the original search query.
	 *   When in doubt simply use 0.5 as a neutral rating.
	 * - The play format has a stream_url property that contains the url that Homey
	 *   can use to stream the content.
	 *
	 * @param track to parse
	 * @returns {parsedTrack}
	 */
	parseTrack(track) {
		return {
			type: 'track',
			id: track.id,
			title: track.name,
			artist: track.artists,
			duration: track.duration_ms,
			artwork: {
				large: (((track.album || {}).images || [])[0] || {}).url,
				medium: (((track.album || {}).images || [])[1] || {}).url,
				small: (((track.album || {}).images || [])[2] || {}).url,
			},
			album: (track.album || {}).name,
			codecs: ['spotify:track:id'],
			confidence: track.popularity,
		};
	}


	parseTracks(tracks) {
		if (!tracks) {
			return [];
		}

		return tracks
			.filter(track => Boolean(track))
			.sort((a, b) => a.popularity < b.popularity) // sort by match score
			.map(track => this.parseTrack(track));
	}

	getMyDevices(forceUpdate) {
		if (!this.isAuthenticated()) return Promise.reject(new Error('not_authenticated'));
		if (forceUpdate || !this.getMyDevicesCache) {
			this.getMyDevicesCache = this.queue.add(() => this.spotifyApi.getMyDevices())
				.then(result => result.body.devices || []);
			clearTimeout(this.myDevicesCacheTimeout);
			this.myDevicesCacheTimeout = setTimeout(() => this.getMyDevicesCache = null, 3000);
		}
		return this.getMyDevicesCache;
	}

	forceStateUpdate() {
		clearTimeout(this.myDevicesCacheTimeout);
		this.getMyDevicesCache = null;
		this.emit('update_state');
	}

};
