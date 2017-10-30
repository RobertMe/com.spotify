'use strict';

const Homey = require('homey');

module.exports = class ConnectSpeakerDriver extends Homey.Driver {

	onInit() {
		this.initFlowListeners();
	}

	onPairListDevices(data, callback) {
		if (!Homey.app.isAuthenticated()) return callback(new Error('not authenticated'));

		Homey.app.getMyDevices()
			.then(devices => {
				console.log('devices', devices);
				callback(null, devices.map(device => ({
					name: device.name,
					data: {
						id: device.id,
						type: device.type,
					},
				})));
			});
	}

	initFlowListeners() {
		new Homey.FlowCardAction('transfer_playback')
			.register()
			.registerRunListener(args => args.device.transferPlayback(true));

		new Homey.FlowCardCondition('is_playing')
			.register()
			.registerRunListener(args =>
				args.device.getPlaybackState(true)
					.then(result => result.is_playing && (!args.device || result.device.id === args.device.getData().id))
					.catch(() => false)
			);

	}

	onPair(socket) {
		super.onPair(socket);

		socket.on('authorized', (data, callback) => {
			callback(null, Homey.app.isAuthenticated());
		});

		const onAuthenticated = (isAuthenticated) => socket.emit('authorized', isAuthenticated);
		Homey.app.on('authenticated', onAuthenticated);

		socket.on('disconnect', () => {
			Homey.app.removeListener('authenticated', onAuthenticated);
		});

		socket.on('oauth2', (data, callback) => {
			Homey.app.startOAuth2(callback);
		});
	}

};
