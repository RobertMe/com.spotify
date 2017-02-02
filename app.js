'use strict';

const SpotifyWebApi = require('spotify-web-api-node');
const spotifyApi = new SpotifyWebApi({
	clientId: Homey.env.CLIENT_ID,
	clientSecret: Homey.env.CLIENT_SECRET,
	redirectUri: Homey.env.REDIRECT_URI,
});

const scopes = [
	'user-read-private',
	'playlist-read-collaborative',
	'user-top-read',
	'user-read-email',
	'user-read-private',
];
const state = 'homey-spotify';
let market;
switch (Homey.manager('i18n').getLanguage()) {
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

const playListOwnerMap = new Map();
function getPlayLists() {
	return getPlayListsRecursive()
		.then(items => Promise.all(
			items.map(playlist => {
				playListOwnerMap.set(playlist.id, playlist.owner.id);
				return getPlayListEntriesRecursive(playlist.owner.id, playlist.id)
					.then(tracks => ({
						type: 'playlist',
						id: playlist.id,
						title: playlist.name,
						tracks: tracks || [],
					}));
			})
		));
}

function getPlayList(id) {
	return Promise.all([
		spotifyApi.getPlaylist(playListOwnerMap.get(id), id),
		getPlayListEntriesRecursive(playListOwnerMap.get(id), id),
	]).then(data => {
		return {
			type: 'playlist',
			id: data[0].body.id,
			title: data[0].body.name,
			tracks: data[1],
		};
	});
}

function getPlayListsRecursive(offset) {
	return spotifyApi.getUserPlaylists(null, { limit: 50, offset })
		.then((data) => {
			if (data.body.next) {
				return getPlayListsRecursive(data.body.offset + data.body.limit)
					.then(nextData => {
						return data.body.items.concat(nextData);
					});
			}
			return data.body.items;
		});
}

function getPlayListEntriesRecursive(ownerId, playListId, offset) {
	return spotifyApi.getPlaylistTracks(ownerId, playListId, { limit: 100, offset })
		.then(data => {
			const items = parseTracks(data.body.items.map(item => item.track));
			if (data.body.next) {
				return getPlayListEntriesRecursive(ownerId, playListId, data.body.offset + data.body.limit)
					.then(nextItems => items.concat(nextItems));
			}
			return items;
		});
}

/**
 * Initialize Google Play Music app with the necessary information:
 * - client ID
 * - client secret
 *
 * Once initialised respond to search, play and playlist request
 * from the Homey Media Manager.
 */
function init() {
	/*
	 * Initialize the Google Play Music client with a previously obtained accessToken whenever possible.
	 */

	Homey.manager('settings').set('authorized', false);
	Homey.manager('api').realtime('authorized', false);

	authorizeSpotify(null, console.log);

	/*
	 * Homey needs to know what formats it can request from this media app so whenever this changes the app
	 * should notify the Homey Media component with the new codecs.
	 */
	Homey.manager('media').change({ codecs: ['spotify:track:id'] });

	/*
	 * Respond to a search request by returning an array of parsed search results
	 */
	Homey.manager('media').on('search', (query, callback) => {
		console.log('onSearch');
		/*
		 * Execute a search using the Google Play Music client.
		 * Since we are only interested in streamable results we apply filters.
		 */
		spotifyApi.searchTracks(query, { limit: 5, market })
			.then((data) => callback(null, parseTracks(data.body.tracks.items)))
			.catch(callback);
	});

	/*
	 * Respond to a play request by returning a parsed track object.
	 * The request object contains a trackId and a format property to indicate what specific
	 * resource and in what format is wanted for playback.
	 */
	Homey.manager('media').on('play', (request, callback) => {
		console.log('onPlay');
		console.log('PLAY', request);
		callback(null, { stream_url: request.trackId });
		// spotifyApi.getTrack(request.trackId, { market })
		// 	.then((data) => {
		// 		console.log(require('util').inspect(data, { depth: 9 }));
		// 		callback(null, parseTrack(data.body));
		// 	})
		// 	.catch(callback);
		// pm.getStreamUrl(request.trackId, (err, url) => {
		// 	if (err) return callback(err);
		//
		// 	callback(null, { stream_url: url });
		// });
	});

	/*
	 * Homey can periodically request static playlist that are available through
	 * the streaming API (when applicable)
	 */
	Homey.manager('media').on('getPlaylists', (data, callback) => {
		console.log('onGetPlaylists');
		getPlayLists()
			.then(playLists => {
				callback(null, playLists);
			})
			.catch(callback);
	});

	/*
	 * Homey might request a specific playlist so it can be refreshed
	 */
	Homey.manager('media').on('getPlaylist', (request, callback) => {
		console.log('onGetPlaylist');
		getPlayList(request.playlistId)
			.then(playList => {
				callback(null, playList);
			})
			.catch(callback);
	});
}

/* ====================================================== */

/**
 * Initiates OAuth for this media app, this is needed when retrieving information specific to a service account.
 * Some user content might only be available when the user is authenticated.
 *
 * @param callback
 */
function startOAuth2(callback) {
	Homey.manager('cloud').generateOAuth2Callback(
		// if the external oauth server requires an Authorization callback URL set it to https://callback.athom.com/oauth2/callback/
		// this is the app-specific authorize url
		spotifyApi.createAuthorizeURL(scopes, state),

		// this function is executed when we got the url to redirect the user to
		callback,

		// this function is executed when the authorization code is received (or failed to do so)
		(err, code) => {
			if (err) {
				return console.error(err);
			}

			authorizeSpotify({ code }, (err, result) => {
				if (!err) {
					Homey.manager('media').requestPlaylistUpdate();
				}
			});
		}
	);
}

let authorizationRefreshTimeout;
function authorizeSpotify(credentials, callback) {
	callback = typeof callback === 'function' ? callback : (() => null);

	if (!credentials) {
		credentials = {
			accessToken: Homey.manager('settings').get('accessToken'),
			refreshToken: Homey.manager('settings').get('refreshToken'),
		};
	}

	const setAuthorized = (accessToken, refreshToken, expiresIn) => {
		// set access and refresh tokens
		spotifyApi.setAccessToken(accessToken);
		Homey.manager('settings').set('accessToken', accessToken);
		if (refreshToken) {
			spotifyApi.setRefreshToken(refreshToken);
			Homey.manager('settings').set('refreshToken', refreshToken);
		}

		Homey.manager('settings').set('authorized', true);
		Homey.manager('api').realtime('authorized', true);

		Homey.manager('media').requestPlaylistUpdate();

		clearTimeout(authorizationRefreshTimeout);
		authorizationRefreshTimeout = setTimeout(() => authorizeSpotify, (expiresIn - 600) * 1000);

		console.log('new credentials', spotifyApi.getCredentials());

		callback(null, true);
	};

	if (credentials.code) {
		spotifyApi.authorizationCodeGrant(credentials.code)
			.then(data => {
				Homey.log('authorized', data);

				setAuthorized(data.body.access_token, data.body.refresh_token, data.body.expires_in);
			})
			.catch(callback);
	} else if (credentials.accessToken && credentials.refreshToken) {
		spotifyApi.setAccessToken(credentials.accessToken);
		spotifyApi.setRefreshToken(credentials.refreshToken);
		spotifyApi.refreshAccessToken()
			.then(data => {
				Homey.log('authorized', data);

				setAuthorized(data.body.access_token, data.body.refresh_token, data.body.expires_in);
			})
			.catch(callback);
	} else {
		console.log('no credentials', credentials);
		callback(new Error('invalid credentials'));
	}
}

/**
 * We deauthorize this media app to use the account specific information
 * it once had access to by resetting our token and notifying Homey Media
 * the new status.
 * @param callback
 */
function deauthorize(callback) {
	Homey.manager('settings').set('credentials', undefined);
	Homey.manager('settings').set('username', undefined);
	Homey.manager('settings').set('authorized', false);
	Homey.manager('api').realtime('authorized', false);

	spotifyApi.resetAccessToken();
	spotifyApi.resetRefreshToken();

	Homey.manager('media').requestPlaylistUpdate();

	return callback();
}

/**
 * Fetches the user profile of the authenticated user.
 *
 * @param callback
 */
function getProfile(callback) {
	console.log(spotifyApi.getCredentials());
	if (!spotifyApi.getCredentials().refreshToken) {
		return callback(new Error('could not fetch profile, user is not authenticated'));
	}

	spotifyApi.getMe()
		.then(data => {
			console.log(data);
			callback(null, data.body);
		})
		.catch(callback);
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
function parseTrack(track) {
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
		format: ['spotify:track:id'],
		confidence: track.popularity,
	};
}


function parseTracks(tracks) {
	console.log('parseTracks');
	if (!tracks) {
		return [];
	}

	return tracks
		.sort((a, b) => a.popularity < b.popularity) // sort by match score
		.map(track => parseTrack(track));
}

/* ====================================================== */

module.exports = {
	init,
	startOAuth2,
	deauthorize,
	getProfile,
};
