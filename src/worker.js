const S3_HEADERS_TO_STRIP = [
	'x-amz-id-2',
	'x-amz-request-id',
	'x-amz-version-id',
	'x-amz-server-side-encryption',
	'x-amz-meta-file-atime',
	'x-amz-meta-file-group',
	'x-amz-meta-file-mtime',
	'x-amz-meta-file-owner',
	'x-amz-meta-file-permissions',
	'x-amz-meta-user-agent',
];

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
	'Access-Control-Max-Age': '86400',
};

const ALLOWED_DOMAINS_TTL = 60 * 60; // 1 hour

const R2_KEY_PREFIX = 'media/collections/';
const CACHE_TTL_OK = 60 * 60 * 24 * 365; // 1 year
const CACHE_TTL_NOT_FOUND = 60; // 1 minute

let cachedDomains = null;
let cachedDomainsExpiry = 0;

async function getAllowedDomains(url) {
	const now = Date.now();

	if (cachedDomains && now < cachedDomainsExpiry) {
		return cachedDomains;
	}

	try {
		const response = await fetch(url);

		if (!response.ok) {
			return cachedDomains || new Set();
		}

		const json = await response.json();
		const domains = new Set(json.data.map((d) => d.name.toLowerCase()));

		cachedDomains = domains;
		cachedDomainsExpiry = now + ALLOWED_DOMAINS_TTL * 1000;

		return domains;
	} catch {
		return cachedDomains || new Set();
	}
}

function isAllowedReferer(referer, allowedDomains) {
	// No Referer header — allow (direct navigation, bookmarks, curl, etc.)
	if (!referer) {
		return true;
	}

	try {
		const hostname = new URL(referer).hostname.toLowerCase();

		// Always allow requests from our own CDN domain
		if (hostname === 'cdn.nextdrop.nl') {
			return true;
		}

		// Check against the allowed domains list
		if (allowedDomains.has(hostname)) {
			return true;
		}

		// Check if it's a subdomain of an allowed domain (e.g. www.shop1.com → shop1.com)
		for (const domain of allowedDomains) {
			if (hostname.endsWith('.' + domain)) {
				return true;
			}
		}

		return false;
	} catch {
		return false;
	}
}

export default {
	async fetch(request, env, ctx) {
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return new Response('Method Not Allowed', { status: 405 });
		}

		// Hotlink protection
		const allowedDomains = await getAllowedDomains(env.ALLOWED_DOMAINS_URL);
		const referer = request.headers.get('Referer');

		if (!isAllowedReferer(referer, allowedDomains)) {
			return new Response('Forbidden', { status: 403 });
		}

		const url = new URL(request.url);
		const cache = caches.default;

		const cached = await cache.match(request);
		if (cached) {
			return cached;
		}

		const path = url.pathname.slice(1);

		if (!path) {
			return new Response('Not Found', { status: 404 });
		}

		const key = R2_KEY_PREFIX + path;

		let object;
		try {
			object = await env.BUCKET.get(key);
		} catch {
			return new Response('Bad Gateway', { status: 502 });
		}

		if (!object) {
			const notFound = new Response('Not Found', {
				status: 404,
				headers: { 'Cache-Control': `public, max-age=${CACHE_TTL_NOT_FOUND}` },
			});
			ctx.waitUntil(cache.put(request, notFound.clone()));
			return notFound;
		}

		const headers = new Headers();
		object.writeHttpMetadata(headers);
		headers.set('Cache-Control', `public, max-age=${CACHE_TTL_OK}, immutable`);
		headers.set('X-Content-Type-Options', 'nosniff');
		headers.set('Access-Control-Allow-Origin', '*');
		headers.set('etag', object.httpEtag);

		for (const header of S3_HEADERS_TO_STRIP) {
			headers.delete(header);
		}

		const response = new Response(object.body, { headers });

		ctx.waitUntil(cache.put(request, response.clone()));

		return response;
	},
};
