(function () {
	'use strict';

	var DEFAULT_API = 'https://steephen-api.onrender.com';
	var KEY_URL = 'vd_api', KEY_TOKEN = 'vd_token';
	var DEMO = new URLSearchParams(location.search).has('demo');

	/* ---------------- helpers ---------------- */

	var $ = function (id) { return document.getElementById(id); };

	// Everything shown here (path, referrer, ISP…) is visitor-controlled input: always escape.
	function esc(v) {
		return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}

	function store(kind) {
		try { return kind === 'local' ? localStorage : sessionStorage; } catch (e) { return null; }
	}
	function getSaved(k) {
		var s = store('session'), l = store('local');
		return (s && s.getItem(k)) || (l && l.getItem(k)) || '';
	}
	function save(k, v, remember) {
		[store('session'), store('local')].forEach(function (s) { if (s) s.removeItem(k); });
		var s = store(remember ? 'local' : 'session');
		if (s && v) s.setItem(k, v);
	}

	function flag(cc) {
		if (!cc || !/^[A-Z]{2}$/i.test(cc)) return '🌐';
		return String.fromCodePoint.apply(null, cc.toUpperCase().split('').map(function (c) { return 0x1f1a5 + c.charCodeAt(0); }));
	}
	var regionNames = (function () { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch (e) { return null; } })();
	function countryName(cc) {
		if (!cc) return 'Unknown';
		try { return (regionNames && regionNames.of(cc)) || cc; } catch (e) { return cc; }
	}
	function place(v) {
		var parts = [v.city, v.region && v.region !== v.city ? v.region : null, countryName(v.country)].filter(Boolean);
		return parts.join(', ');
	}
	function ago(d) {
		var s = (Date.now() - new Date(d).getTime()) / 1000;
		if (s < 60) return 'just now';
		var units = [[60, 'min'], [3600, 'h'], [86400, 'd'], [604800, 'w'], [2592000, 'mo'], [31536000, 'y']];
		for (var i = units.length - 1; i >= 0; i--) if (s >= units[i][0]) return Math.floor(s / units[i][0]) + units[i][1] + ' ago';
		return 'just now';
	}
	function fmtDate(d) {
		return new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
	}
	function coord(n) { return typeof n === 'number' ? n.toFixed(4) : '–'; }
	function deviceIcon(d) { return d === 'mobile' ? 'bx-mobile' : d === 'tablet' ? 'bx-tab' : 'bx-desktop'; }

	// Tiering: returning = seen on 2+ different days; frequent = 3+ days or 5+ page views.
	function tier(v) {
		if (v.activeDays >= 3 || v.visits >= 5) return 'freq';
		if (v.activeDays >= 2) return 'ret';
		return 'new';
	}
	var TIER_COLOR = { new: '#8ab4ff', ret: '#2ee59d', freq: '#ff5a1f' };
	var TIER_LABEL = { ret: 'Returning', freq: 'Frequent' };

	/* ---------------- API ---------------- */

	var api = { url: '', token: '' };

	function request(path) {
		if (DEMO) return Promise.resolve(demoResponse(path));
		return fetch(api.url.replace(/\/+$/, '') + path, {
			headers: api.token ? { Authorization: 'Bearer ' + api.token } : {},
			referrerPolicy: 'no-referrer',
		}).then(function (r) {
			return r.json().catch(function () { return {}; }).then(function (body) {
				if (!r.ok) {
					var err = new Error(body.message || ('Request failed (' + r.status + ')'));
					err.status = r.status;
					throw err;
				}
				return body;
			});
		});
	}

	/* ---------------- state ---------------- */

	var state = { visitors: [], filter: 'all', query: '', selected: null };
	var map, layer, markersById = {};

	/* ---------------- login ---------------- */

	function showLogin(message) {
		$('app').hidden = true;
		$('login').hidden = false;
		$('api-url').value = getSaved(KEY_URL) || DEFAULT_API;
		$('api-token').value = '';
		$('remember').checked = !!(store('local') && store('local').getItem(KEY_TOKEN));
		$('login-error').textContent = message || '';
		setTimeout(function () { $('api-token').focus(); }, 50);
	}

	$('login-form').addEventListener('submit', function (e) {
		e.preventDefault();
		var btn = e.target.querySelector('button');
		api.url = $('api-url').value.trim();
		api.token = $('api-token').value.trim();
		btn.disabled = true;
		$('login-error').textContent = '';
		request('/api/admin/visitors?days=1&limit=1')
			.then(function () {
				var remember = $('remember').checked;
				save(KEY_URL, api.url, true);
				save(KEY_TOKEN, api.token, remember);
				openApp();
			})
			.catch(function (err) {
				$('login-error').textContent = err.status === 401 ? 'Wrong token.' : err.message || 'Could not reach the API.';
			})
			.finally(function () { btn.disabled = false; });
	});

	$('logout').addEventListener('click', function () {
		save(KEY_TOKEN, '', false);
		api.token = '';
		showLogin();
	});

	/* ---------------- app ---------------- */

	function openApp() {
		$('login').hidden = true;
		$('app').hidden = false;
		$('logout').hidden = !api.token;
		if (!map) initMap();
		setTimeout(function () { map.invalidateSize(); }, 50);
		load();
	}

	function initMap() {
		map = L.map('map', { worldCopyJump: true, minZoom: 2, zoomControl: true, attributionControl: true }).setView([25, 30], 2);
		var esri = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';
		L.tileLayer(esri + 'World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
			maxZoom: 16,
			attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
		}).addTo(map);
		// city / country labels on top of the base layer
		L.tileLayer(esri + 'World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16, pane: 'overlayPane' }).addTo(map);
		layer = L.featureGroup().addTo(map);
		window.addEventListener('resize', function () { map.invalidateSize(); });
	}

	function load() {
		var days = $('range').value;
		$('refresh').classList.add('spin');
		$('status').textContent = 'Loading…';
		request('/api/admin/visitors?days=' + encodeURIComponent(days) + '&limit=1000')
			.then(function (data) {
				state.visitors = data.visitors || [];
				visitsCache = {};
				renderKpis(data.totals || {});
				renderMap();
				renderList();
			})
			.catch(function (err) {
				if (err.status === 401) return showLogin(api.token ? 'Session expired — sign in again.' : '');
				$('status').textContent = 'Error: ' + err.message;
			})
			.finally(function () { $('refresh').classList.remove('spin'); });
	}

	$('range').addEventListener('change', load);
	$('refresh').addEventListener('click', load);
	$('search').addEventListener('input', function (e) { state.query = e.target.value.trim().toLowerCase(); renderList(); });
	document.querySelectorAll('.chip').forEach(function (chip) {
		chip.addEventListener('click', function () {
			document.querySelectorAll('.chip').forEach(function (c) { c.classList.toggle('active', c === chip); });
			state.filter = chip.getAttribute('data-filter');
			renderMap();
			renderList();
		});
	});

	function filtered() {
		return state.visitors.filter(function (v) {
			var t = tier(v);
			if (state.filter === 'returning' && t === 'new') return false;
			if (state.filter === 'frequent' && t !== 'freq') return false;
			if (!state.query) return true;
			var hay = [v.city, v.region, v.country, countryName(v.country), v.isp, v.browser, v.os, v.device]
				.concat(v.ips || []).join(' ').toLowerCase();
			return hay.indexOf(state.query) !== -1;
		});
	}

	function renderKpis(t) {
		$('k-visitors').textContent = t.visitors != null ? t.visitors : 0;
		$('k-visits').textContent = t.visits != null ? t.visits : 0;
		$('k-returning').textContent = t.returning != null ? t.returning : 0;
		$('k-countries').textContent = t.countries != null ? t.countries : 0;
	}

	function renderMap() {
		layer.clearLayers();
		markersById = {};
		var list = filtered();
		// draw one-time visitors first so frequent ones sit on top
		var order = { new: 0, ret: 1, freq: 2 };
		list.slice().sort(function (a, b) { return order[tier(a)] - order[tier(b)]; }).forEach(function (v) {
			var locs = (v.locations && v.locations.length) ? v.locations : (typeof v.lat === 'number' ? [v] : []);
			var t = tier(v);
			var size = Math.round(Math.min(26 + Math.sqrt(v.visits) * 4, 52));
			locs.forEach(function (loc) {
				if (typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return;
				// pin shows the visit count; size grows with it
				var m = L.marker([loc.lat, loc.lng], {
					icon: L.divIcon({
						className: 'pin-wrap',
						html: '<span class="pin ' + t + '" style="width:' + size + 'px;height:' + size + 'px">' + esc(v.visits) + '</span>',
						iconSize: [size, size],
						iconAnchor: [size / 2, size / 2],
						popupAnchor: [0, -size / 2],
					}),
					riseOnHover: true,
					zIndexOffset: { new: 0, ret: 500, freq: 1000 }[t],
				});
				m.bindPopup(
					'<div class="pop">' +
					'<b>' + flag(loc.country) + ' ' + esc(place(loc)) + '</b>' +
					'<div class="mono">' + coord(loc.lat) + ', ' + coord(loc.lng) + '</div>' +
					'<div class="pop-stats"><span><strong>' + esc(v.visits) + '</strong> visit' + (v.visits === 1 ? '' : 's') + '</span>' +
						'<span><strong>' + esc(v.activeDays) + '</strong> day' + (v.activeDays === 1 ? '' : 's') + '</span></div>' +
					'<div class="pop-row">First: ' + esc(fmtDate(v.firstSeen)) + '</div>' +
					'<div class="pop-row">Last: ' + esc(fmtDate(v.lastSeen)) + ' (' + esc(ago(v.lastSeen)) + ')</div>' +
					'<div class="pop-times" data-times="' + esc(v.id) + '">Loading visit times…</div>' +
					'<button type="button" data-open="' + esc(v.id) + '">Full details</button>' +
					'</div>',
					{ maxWidth: 280 }
				);
				m.on('popupopen', function (e) { loadPopupTimes(v.id, e.popup); });
				m.addTo(layer);
				(markersById[v.id] = markersById[v.id] || []).push(m);
			});
		});
		if (layer.getLayers().length) {
			map.fitBounds(layer.getBounds().pad(0.3), { maxZoom: 5 });
		}
	}

	// cache per visitor so reopening a popup is instant
	var visitsCache = {};
	function fetchVisits(id) {
		if (!visitsCache[id]) {
			visitsCache[id] = request('/api/admin/visitors/' + encodeURIComponent(id) + '/visits')
				.then(function (d) { return d.visits || []; })
				.catch(function (err) { delete visitsCache[id]; throw err; });
		}
		return visitsCache[id];
	}

	function loadPopupTimes(id, popup) {
		fetchVisits(id).then(function (visits) {
			var el = popup.getElement() && popup.getElement().querySelector('[data-times]');
			if (!el) return;
			var shown = visits.slice(0, 8);
			el.innerHTML = '<div class="pop-label">Visits</div>' + shown.map(function (x) {
				return '<div class="pop-time"><span>' + esc(fmtDate(x.createdAt)) + '</span><em>' + esc(x.path) + '</em></div>';
			}).join('') + (visits.length > shown.length ? '<div class="pop-more">+' + (visits.length - shown.length) + ' more</div>' : '');
			popup.update();
		}).catch(function () {
			var el = popup.getElement() && popup.getElement().querySelector('[data-times]');
			if (el) el.textContent = 'Could not load visit times.';
		});
	}

	document.addEventListener('click', function (e) {
		var b = e.target.closest && e.target.closest('[data-open]');
		if (b) openVisitor(b.getAttribute('data-open'));
	});

	function renderList() {
		var list = filtered();
		var ul = $('visitors');
		$('status').textContent = list.length
			? list.length + ' visitor' + (list.length === 1 ? '' : 's') + (DEMO ? ' · demo data' : '')
			: 'No visitors match.';
		ul.innerHTML = list.map(function (v) {
			var t = tier(v);
			return '<li><button type="button" class="v' + (state.selected === v.id ? ' selected' : '') + '" data-id="' + esc(v.id) + '">' +
				'<span class="flag">' + flag(v.country) + '</span>' +
				'<span class="v-main">' +
					'<span class="v-title">' + esc(place(v)) + (TIER_LABEL[t] ? '<span class="badge ' + t + '">' + TIER_LABEL[t] + '</span>' : '') + '</span>' +
					'<span class="v-sub"><i class="bx ' + deviceIcon(v.device) + '"></i> ' + esc([v.browser, v.os].filter(Boolean).join(' · ')) +
						(v.isp ? ' · ' + esc(v.isp) : '') + '</span>' +
					'<span class="v-sub">Last seen ' + esc(ago(v.lastSeen)) + ' · ' + esc(v.activeDays) + ' day' + (v.activeDays === 1 ? '' : 's') + '</span>' +
				'</span>' +
				'<span class="v-count"><strong>' + esc(v.visits) + '</strong><span>views</span></span>' +
			'</button></li>';
		}).join('');
	}

	$('visitors').addEventListener('click', function (e) {
		var b = e.target.closest('.v');
		if (b) openVisitor(b.getAttribute('data-id'));
	});

	/* ---------------- detail drawer ---------------- */

	function openVisitor(id) {
		var v = state.visitors.find(function (x) { return x.id === id; });
		if (!v) return;
		state.selected = id;
		renderList();
		map.closePopup();
		var ms = markersById[id];
		if (ms && ms.length) map.flyTo(ms[0].getLatLng(), Math.max(map.getZoom(), 6), { duration: .6 });

		var t = tier(v);
		var hasCoords = typeof v.lat === 'number' && typeof v.lng === 'number';
		var latlng = hasCoords ? coord(v.lat) + ', ' + coord(v.lng) : 'Unknown';
		var others = (v.locations || []).filter(function (l) { return !(l.lat === v.lat && l.lng === v.lng); });

		$('drawer-body').innerHTML =
			'<div class="d-head"><span class="flag">' + flag(v.country) + '</span><div>' +
				'<h3 id="d-title">' + esc(place(v)) + (TIER_LABEL[t] ? '<span class="badge ' + t + '">' + TIER_LABEL[t] + '</span>' : '') + '</h3>' +
				'<p>First seen ' + esc(fmtDate(v.firstSeen)) + '</p></div></div>' +
			'<div class="d-stats">' +
				'<div><strong>' + esc(v.visits) + '</strong><span>Page views</span></div>' +
				'<div><strong>' + esc(v.activeDays) + '</strong><span>Active days</span></div>' +
				'<div><strong>' + esc(ago(v.lastSeen).replace(' ago', '')) + '</strong><span>Last seen</span></div>' +
			'</div>' +
			'<div class="coords"><i class="bx bx-current-location"></i><span class="mono">' + latlng + '</span>' +
				(hasCoords ? '<button type="button" id="copy-coords">Copy</button><a href="https://www.google.com/maps?q=' + v.lat + ',' + v.lng + '" target="_blank" rel="noopener noreferrer">Maps ↗</a>' : '') +
			'</div>' +
			'<p class="note">Coordinates come from IP geolocation and are usually accurate to the city or ISP hub, not a street address.</p>' +
			'<dl class="kv">' +
				'<dt>ISP / Org</dt><dd>' + esc(v.isp || '–') + '</dd>' +
				'<dt>Timezone</dt><dd>' + esc(v.timezone || '–') + '</dd>' +
				'<dt>Device</dt><dd>' + esc([v.device, v.browser, v.os].filter(Boolean).join(' · ') || '–') + '</dd>' +
				'<dt>IP' + ((v.ips || []).length > 1 ? 's' : '') + '</dt><dd class="mono">' + (v.ips || []).map(esc).join('<br>') + '</dd>' +
				(others.length ? '<dt>Also from</dt><dd>' + others.map(function (l) { return esc(place(l)) + ' <span class="mono">(' + coord(l.lat) + ', ' + coord(l.lng) + ')</span>'; }).join('<br>') + '</dd>' : '') +
				((v.referrers || []).length ? '<dt>Came from</dt><dd>' + v.referrers.map(esc).join('<br>') + '</dd>' : '') +
				'<dt>Visitor ID</dt><dd class="mono">' + esc(v.id) + '</dd>' +
			'</dl>' +
			'<h4 class="d-section">Visit history</h4>' +
			'<ul class="timeline" id="d-timeline"><li class="muted">Loading…</li></ul>';

		var copy = $('copy-coords');
		if (copy) copy.addEventListener('click', function () {
			var text = v.lat + ', ' + v.lng;
			(navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () {
				copy.textContent = 'Copied';
				setTimeout(function () { copy.textContent = 'Copy'; }, 1500);
			}).catch(function () {});
		});

		openDrawer();

		fetchVisits(id).then(function (visits) {
			if (state.selected !== id) return;
			$('d-timeline').innerHTML = visits.map(function (x) {
				return '<li><time>' + esc(fmtDate(x.createdAt)) + '</time>' +
					'<div class="path">' + esc(x.path) + '</div>' +
					'<div class="meta">' + esc([place(x), coord(x.lat) + ', ' + coord(x.lng)].join(' · ')) + '</div>' +
					'<div class="meta">' + esc([x.ip, x.browser, x.os].filter(Boolean).join(' · ')) +
						(x.referrer ? ' · from ' + esc(x.referrer) : '') + '</div></li>';
			}).join('') || '<li class="muted">No visits.</li>';
		}).catch(function (err) {
			$('d-timeline').innerHTML = '<li class="error">' + esc(err.message) + '</li>';
		});
	}

	var drawer = $('drawer');
	function openDrawer() {
		drawer.classList.add('open');
		drawer.setAttribute('aria-hidden', 'false');
		drawer.querySelector('.drawer-panel').scrollTop = 0;
	}
	function closeDrawer() {
		drawer.classList.remove('open');
		drawer.setAttribute('aria-hidden', 'true');
		state.selected = null;
		renderList();
	}
	drawer.addEventListener('click', function (e) { if (e.target.closest('[data-close]')) closeDrawer(); });
	document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && drawer.classList.contains('open')) closeDrawer(); });

	/* ---------------- demo data (?demo) ---------------- */

	function demoResponse(path) {
		var cities = [
			['AE', 'Dubai', 'Dubai', 25.2048, 55.2708, 'Etisalat'], ['IN', 'Kochi', 'Kerala', 9.9312, 76.2673, 'Reliance Jio'],
			['IN', 'Bengaluru', 'Karnataka', 12.9716, 77.5946, 'Siemens AG'], ['DE', 'Munich', 'Bavaria', 48.1351, 11.582, 'Deutsche Telekom'],
			['NL', 'Veghel', 'North Brabant', 51.6167, 5.5486, 'Vanderlande Industries'], ['US', 'Los Angeles', 'California', 34.0522, -118.2437, 'Comcast'],
			['GB', 'London', 'England', 51.5072, -0.1276, 'BT'], ['SG', 'Singapore', 'Singapore', 1.3521, 103.8198, 'Singtel'],
		];
		var now = Date.now();
		var visitors = cities.map(function (c, i) {
			var visits = [1, 7, 4, 2, 9, 1, 3, 1][i], days = [1, 5, 2, 2, 4, 1, 1, 1][i];
			return {
				id: 'demo-' + i, visits: visits, activeDays: days,
				firstSeen: new Date(now - (days * 3 + 1) * 864e5).toISOString(), lastSeen: new Date(now - i * 3.7e6).toISOString(),
				ips: ['203.0.113.' + (10 + i)], paths: ['/', '/oauth2.html'], referrers: i % 2 ? ['https://www.linkedin.com/'] : [],
				locations: [{ lat: c[3], lng: c[4], city: c[1], region: c[2], country: c[0] }],
				country: c[0], city: c[1], region: c[2], lat: c[3], lng: c[4], timezone: '', isp: c[5],
				browser: i % 2 ? 'Mobile Safari' : 'Chrome', os: i % 2 ? 'iOS' : 'Android', device: i % 3 ? 'mobile' : 'desktop',
			};
		});
		if (path.indexOf('/visits') > -1 && path.indexOf('/visitors/') > -1) {
			var v = visitors.find(function (x) { return path.indexOf(encodeURIComponent(x.id)) > -1; }) || visitors[0];
			return { visits: Array.from({ length: v.visits }, function (_, k) {
				return { createdAt: new Date(now - k * 9e7).toISOString(), path: k % 2 ? '/oauth2.html' : '/', city: v.city, region: v.region, country: v.country, lat: v.lat, lng: v.lng, ip: v.ips[0], browser: v.browser, os: v.os };
			}) };
		}
		return {
			totals: { visitors: visitors.length, visits: visitors.reduce(function (s, v) { return s + v.visits; }, 0), returning: visitors.filter(function (v) { return v.activeDays >= 2; }).length, countries: 7 },
			visitors: visitors,
		};
	}

	/* ---------------- boot ---------------- */

	api.url = getSaved(KEY_URL) || DEFAULT_API;
	api.token = getSaved(KEY_TOKEN);
	// Try without a login first; the API only asks for a token (401) when ADMIN_TOKEN is set.
	openApp();
})();
