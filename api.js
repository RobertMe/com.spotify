'use strict';

const Homey = require('homey');

module.exports = [

	{
		method: 'GET',
		path: '/oauth2',
		fn: (args, callback) => {
			Homey.app.startOAuth2(callback);
		},
	},

	{
		method: 'POST',
		path: '/deauthorize',
		fn: (args, callback) => {
			Homey.app.deauthorize(callback);
		},
	},

	{
		method: 'GET',
		path: '/profile',
		fn: (args, callback) => {
			Homey.app.getProfile(callback);
		},
	},

];
