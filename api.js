'use strict';

module.exports = [

	{
		method: 'GET',
		path: '/oauth2',
		fn: (callback, args) => {
			Homey.app.startOAuth2(callback);
		},
	},

	{
		method: 'POST',
		path: '/deauthorize',
		fn: (callback, args) => {
			Homey.app.deauthorize(callback);
		},
	},

	{
		method: 'GET',
		path: '/profile',
		fn: (callback, args) => {
			Homey.app.getProfile(callback);
		},
	},

];
