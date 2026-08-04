import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

export const APPROVED_ZAPIER_HOSTS = Object.freeze(['hooks.zapier.com']);
export const APPROVED_PUBLIC_BASE_HOSTS = Object.freeze(['news.questtales.com']);

const blockedAddresses = new BlockList();
const blockedMappedIpv6Addresses = new BlockList();
blockedMappedIpv6Addresses.addSubnet('::ffff:0:0', 96, 'ipv6');

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  blockedAddresses.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['::', 96],
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fec0::', 10],
  ['fe80::', 10],
  ['ff00::', 8],
]) {
  blockedAddresses.addSubnet(network, prefix, 'ipv6');
}

function policyError(message) {
  const error = new Error(`Gatekeeper network policy rejected destination: ${message}`);
  error.code = 'destination_not_approved';
  return error;
}

function parseBoundedUrl(raw, name) {
  if (typeof raw !== 'string' || !raw || raw.length > 2_048 || raw !== raw.trim()) {
    throw policyError(`${name} must be a bounded URL without surrounding whitespace`);
  }
  try {
    return new URL(raw);
  } catch {
    throw policyError(`${name} must be a valid URL`);
  }
}

function assertHttpsAuthority(url, name) {
  if (url.protocol !== 'https:'
    || url.username
    || url.password
    || url.port
    || url.hash) {
    throw policyError(`${name} must use HTTPS on the default port without credentials or fragments`);
  }
}

export function validateApprovedZapierUrl(raw, name = 'Zapier URL') {
  const url = parseBoundedUrl(raw, name);
  assertHttpsAuthority(url, name);
  if (!APPROVED_ZAPIER_HOSTS.includes(url.hostname.toLowerCase())) {
    throw policyError(`${name} hostname is not approved`);
  }
  return url.toString();
}

export function validateApprovedPublicBaseUrl(raw, name = 'public base URL') {
  const url = parseBoundedUrl(raw, name);
  assertHttpsAuthority(url, name);
  if (!APPROVED_PUBLIC_BASE_HOSTS.includes(url.hostname.toLowerCase())) {
    throw policyError(`${name} hostname is not approved`);
  }
  if (url.pathname !== '/' || url.search) {
    throw policyError(`${name} must be an origin without a path or query`);
  }
  return url.toString().replace(/\/$/u, '');
}

export function isPublicNetworkAddress(address) {
  const normalized = String(address || '').replace(/^\[|\]$/gu, '').split('%', 1)[0];
  const family = isIP(normalized);
  if (family === 4) return !blockedAddresses.check(normalized, 'ipv4');
  if (family === 6) {
    if (normalized.toLowerCase().startsWith('::ffff:')) return false;
    if (blockedMappedIpv6Addresses.check(normalized, 'ipv6')) return false;
    return !blockedAddresses.check(normalized, 'ipv6');
  }
  return false;
}

export async function resolveHostAddresses(hostname, lookupImpl = lookup) {
  const records = await lookupImpl(hostname, { all: true, verbatim: true });
  if (!Array.isArray(records)) return [];
  return records.map((record) => (typeof record === 'string' ? record : record?.address));
}

export function assertPublicResolution(addresses) {
  if (!Array.isArray(addresses)
    || addresses.length === 0
    || addresses.some((address) => !isPublicNetworkAddress(address))) {
    throw policyError('hostname resolved to an empty, private, or special-use address set');
  }
  return Object.freeze([...addresses]);
}

export async function postApprovedJson({
  url,
  headers,
  body,
  timeoutMs,
  resolveHost = resolveHostAddresses,
  requestImpl = httpsRequest,
}) {
  const approvedUrl = validateApprovedZapierUrl(url);
  const parsed = new URL(approvedUrl);
  const addresses = assertPublicResolution(await resolveHost(parsed.hostname));
  const selectedAddress = addresses[0];
  const family = isIP(selectedAddress);
  const approvedHeaders = Object.create(null);
  for (const [name, value] of Object.entries(headers || {})) {
    const normalizedName = name.toLowerCase();
    if (normalizedName === 'host' || normalizedName === 'content-length') continue;
    approvedHeaders[name] = value;
  }
  approvedHeaders.host = parsed.host;
  approvedHeaders['content-length'] = Buffer.byteLength(body);

  return new Promise((resolve, reject) => {
    const request = requestImpl(approvedUrl, {
      method: 'POST',
      headers: approvedHeaders,
      servername: parsed.hostname,
      lookup(requestedHostname, options, callback) {
        if (String(requestedHostname).toLowerCase() !== parsed.hostname.toLowerCase()) {
          callback(policyError('transport attempted to resolve an unexpected hostname'));
          return;
        }
        if (options?.all) callback(null, [{ address: selectedAddress, family }]);
        else callback(null, selectedAddress, family);
      },
    }, (response) => {
      const status = response.statusCode;
      response.destroy();
      resolve({ status });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('Zapier request timed out'));
    });
    request.once('error', reject);
    request.end(body);
  });
}
