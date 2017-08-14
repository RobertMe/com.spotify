'use strict';

const Homey = require('homey');

module.exports = class ConnectSpeakerDevice extends Homey.Device {

	onInit() {
		const initSpeaker = () => {
			this._initSpeaker()
				.catch((err) => {
					this.error('InitSpeaker error:', err);
					setTimeout(initSpeaker, 30000);
				});
		};

		if (!Homey.app.authenticated) {
			this.setUnavailable();
			Homey.app.once('authenticated', initSpeaker);
		} else {
			initSpeaker();
		}
		this.api = Homey.app.getApi();

		this.registerCapabilityListener('volume_set', this.wrapCapabilityListener.bind(this, this.setPlaybackVolume));
		this.registerCapabilityListener('volume_mute', this.wrapCapabilityListener.bind(this, this.setVolumeMute));
		this.registerCapabilityListener('speaker_playing', this.wrapCapabilityListener.bind(this, this.setPlayback));
		this.registerCapabilityListener('speaker_prev', this.wrapCapabilityListener.bind(this, this.skipPlaybackPrevious));
		this.registerCapabilityListener('speaker_next', this.wrapCapabilityListener.bind(this, this.skipPlaybackNext));
		Homey.app.on('update_state', this.updateState.bind(this));
	}

	async _initSpeaker() {
		await this.updateState(this);
		this.speaker = new Homey.Speaker(this);

		this.speaker.on('setTrack', (data, callback) => {
			const trackUri = `spotify:track:${data.track.stream_url}`;
			// This handles the queuing of tracks. Homey will send the next track before the current track is done to enable
			// the speaker to start buffering the next track. If a speaker does not implement prebuffering so it can set a
			// timeout. It is important to handle the queued tracks being overwritten by a subsequent setTrack event.

			// Check if the device has an queuedCallback option indicating that there already is a track queued
			if (this.queuedCallback) {
				// Call the callback with the track that is queued with an error to indicate that the corresponding track is cancelled
				this.queuedCallback(new Error('setTrack debounced'));
				// Clear the callback from the device object
				this.queuedCallback = null;
				// Clear the timeout that was intended to play the track on the speaker
				clearTimeout(this.queuedTimeout);
			}

			// Check if there is a delay specified in the opts object
			if (data.opts.delay) {
				// if so, set the callback on the device object
				this.queuedCallback = callback;
				// Set a timeout function which will play the track on the speaker when the timeout fires
				this.queuedTimeout = setTimeout(() => {
					// When the timeout is fired clear the corresponding variables from the device object
					this.queuedCallback = null;
					// Call the function which will play the track
					this.startPlayback(trackUri, data.opts.position, !data.opts.startPlaying)
						.then(() => this.speaker.updateState({ position: data.opts.position, track: data.track }))
						.then(this.updateSpeakerState.bind(this, true))
						.then(() => callback(null, data.track))
						.catch(callback);
					this.queuedTimeout = null;
				}, data.opts.delay); // set the timeout for the given delay in the opts object
			} else {
				// Call the function which will play the track
				this.startPlayback(trackUri, data.opts.position, !data.opts.startPlaying)
					.then(() => this.speaker.updateState({ position: data.opts.position, track: data.track }))
					.then(this.updateSpeakerState.bind(this, true))
					.then(() => callback(null, data.track))
					.catch(callback);
			}
		});

		this.speaker.on('setPosition', (position, callback) => {
			this.seekPlayback(position)
				.then(() => callback(null, position))
				.catch(callback);
		});

		this.speaker.on('setActive', async (isSpeakerActive, callback) => {
			this.log('became active', isSpeakerActive);
			if (isSpeakerActive) {
				this.isSpeakerActive = isSpeakerActive;

				await this.transferPlayback(false)
					.catch((err) => {
						callback(err);
						return Promise.reject(err);
					});
				// Set an interval to poll the state of the external speaker. This is usefull to let Homey know the exact
				// state of the speaker which enables Homey to better sync playback position and play/pause state
				const setUpdateSpeakersStateTimeout = () => {
					if (!this.isSpeakerActive) return;
					this.updateSpeakerStateTimeout = setTimeout(
						() => this.updateSpeakerState()
							.catch(() => null)
							.then(() => setUpdateSpeakersStateTimeout()),
						5000
					);
				};
				setUpdateSpeakersStateTimeout();

				// Return the callback with the new state of the speaker
				callback(null, isSpeakerActive);
			} else {
				this.isSpeakerActive = false;
				// Clear polling since inactive speakers are not interesting to listen to
				clearTimeout(this.updateSpeakerStateTimeout);
				// When the speaker becomes inactive execute code to release the device from Homey control
				callback(null, false);
			}
		});

		return this.speaker.register({
			codecs: ['spotify:track:id']
		});
	}

	updateSpeakerState(forceUpdate) {
		return this.updateState(forceUpdate)
			.then(() => {
				if (!(this.isActive && this.playbackState && this.playbackState.device.id === this.getData().id)) {
					return this.speaker.setInactive('Speaker became inactive');
				}
				return this.speaker.updateState({ position: this.progressMs })
			});
	}

	onDeleted() {
		clearTimeout(this.updateStateTimeout);
	}

	wrapCapabilityListener(fn, ...args) {
		this.log('calling', fn.name);
		fn.apply(this, args)
			.then((result) => {
				this.log(fn.name, 'result', result);
				args.pop()(null, args.shift());
			})
			.catch(err => {
				this.error(fn.name, 'error', err);
				args.pop()(err);
			});
	}

	updateState(forceUpdate) {
		return this.getState(forceUpdate)
			.then(async device => {
				this.setAvailable();
				this.isActive = device.is_active;
				this.isRestricted = device.is_restricted;

				if (this.isActive) {
					const playbackState = await this.getPlaybackState(forceUpdate);
					this.playbackState = playbackState;
					this.playbackItem = playbackState.item;
					this.isPlaying = playbackState.is_playing;
					this.progressMs = Math.round(playbackState.progress_ms);
					this.repeatState = playbackState.repeat_state === 'on';
					this.shuffleState = playbackState.shuffle_state;
				} else {
					this.playbackState = null;
					this.playbackItem = null;
					this.progressMs = null;
					this.isPlaying = false;
				}
				if (!(this.getStoreValue('soft_muted') && device.volume_percent === 0)) {
					await
						this.setCapabilityValue('volume_set', Math.round(device.volume_percent) / 100);
				}
				return this.setCapabilityValue('speaker_playing', this.isPlaying || false);
			})
			.catch(err => {
				this.log('updateState Error:', err);
				this.setUnavailable(Homey.__('device_not_found'));
			});
	}

	setPlayback(state) {
		return state ? this.startPlayback() : this.pausePlayback();
	}

	async setVolumeMute(state) {
		if (!state) {
			this.setStoreValue('soft_muted', false);
			return this.setPlaybackVolume(this.getStoreValue('unmute_volume') || 50);
		}
		this.setStoreValue('soft_muted', true);
		this.setStoreValue('unmute_volume', (await this.getState()).volume_percent);
		return this.setPlaybackVolume(0);
	}

	getState() {
		return Homey.app.getMyDevices()
			.then(devices => devices.find(device => device.id === this.getData().id) || Promise.reject('device_not_found'));
	}

	getPlaybackState(forceUpdate) {
		if (forceUpdate || !this.currentPlaybackStateCache) {
			this.currentPlaybackStateCache = Homey.app.queue.add(() => this.api.getMyCurrentPlaybackState())
				.then(result => result.body);
			clearTimeout(this.currentPlaybackStateCacheTimeout);
			this.currentPlaybackStateCacheTimeout = setTimeout(() => this.currentPlaybackStateCache = null, 3000);
		}
		return this.currentPlaybackStateCache;
	}

	setPlaybackVolume(volume) {
		return Homey.app.queue.add(() => this.api.setMyPlaybackVolume({
			device_id: this.getData().id,
			volume_percent: Math.round(volume < 1 ? volume * 100 : volume)
		}));
	}

	seekPlayback(position) {
		return Homey.app.queue.add(() => this.api.seekMyPlayback({
			device_id: this.getData().id,
			position_ms: Math.round(position)
		}));
	}

	skipPlaybackNext() {
		return Homey.app.queue.add(() => this.api.skipMyPlaybackNext({ device_id: this.getData().id }))
			.then(result => {
				if (!this.isActive) {
					Homey.app.forceStateUpdate(true);
				}
				return result;
			});
	}

	skipPlaybackPrevious() {
		return Homey.app.queue.add(() => this.api.skipMyPlaybackPrevious({ device_id: this.getData().id }))
			.then(result => {
				if (!this.isActive) {
					Homey.app.forceStateUpdate(true);
				}
				return result;
			});
	}

	pausePlayback() {
		return Homey.app.queue.add(() => this.api.pauseMyPlayback({ device_id: this.getData().id }));
	}

	async startPlayback(uri, offset, pauseAfterLoad) {
		const isActive = (await this.getState()).is_active;
		if (!isActive) {
			await this.transferPlayback(false);
		}
		return Homey.app.queue.add(() => this.api.startMyPlayback({
			device_id: this.getData().id,
			uris: uri ? [uri] : undefined,
			offset
		}))
			.then(async result => {
				if (pauseAfterLoad) {
					await this.pausePlayback();
				}
				if (!isActive) {
					Homey.app.forceStateUpdate(true);
				}
				return result;
			});
	}

	transferPlayback(startPlaying) {
		return Homey.app.queue.add(() => this.api.transferMyPlayback({
			device_ids: [this.getData().id],
			play: startPlaying
		}));
	}
};
