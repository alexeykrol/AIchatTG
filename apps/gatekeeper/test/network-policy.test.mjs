import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  assertPublicResolution,
  isPublicNetworkAddress,
  postApprovedJson,
  resolveHostAddresses,
  validateConfiguredPublicOrigin,
  validateApprovedZapierUrl,
} from '../src/network-policy.mjs';

describe('outbound network policy', () => {
  test('accepts only exact approved HTTPS authorities', () => {
    assert.equal(
      validateApprovedZapierUrl('https://hooks.zapier.com/hooks/catch/123/opaque'),
      'https://hooks.zapier.com/hooks/catch/123/opaque',
    );
    assert.equal(
      validateConfiguredPublicOrigin('https://gatekeeper.example.test/'),
      'https://gatekeeper.example.test',
    );
    for (const destination of [
      'http://hooks.zapier.com/hook',
      'https://hooks.zapier.com:444/hook',
      'https://user:pass@hooks.zapier.com/hook',
      'https://hooks.zapier.com.evil.example/hook',
      'https://10.0.0.1/hook',
      'https://[fd00::1]/hook',
    ]) {
      assert.throws(() => validateApprovedZapierUrl(destination), /network policy rejected/u);
    }
    assert.throws(
      () => validateConfiguredPublicOrigin('https://gatekeeper.example.test/private'),
      /origin without a path or query/u,
    );
    for (const destination of [
      'https://GATEKEEPER.example.test',
      'https://localhost',
      'https://127.0.0.1',
      'https://[::1]',
    ]) {
      assert.throws(() => validateConfiguredPublicOrigin(destination), /network policy rejected/u);
    }
  });

  test('rejects private, metadata, carrier, documentation and special-use addresses', () => {
    const rejected = [
      '0.0.0.0',
      '10.0.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.0.2.1',
      '192.168.50.10',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      '::127.0.0.1',
      '::ffff:10.0.0.1',
      '0:0:0:0:0:ffff:7f00:1',
      '64:ff9b::a00:1',
      '2001:db8::1',
      '2002::1',
      'fd00::1',
      'fec0::1',
      'feff::1',
      'fe80::1',
      'ff02::1',
    ];
    for (const address of rejected) assert.equal(isPublicNetworkAddress(address), false, address);
    assert.equal(isPublicNetworkAddress('8.8.8.8'), true);
    assert.equal(isPublicNetworkAddress('2001:4860:4860::8888'), true);
    assert.throws(() => assertPublicResolution(['8.8.8.8', '10.0.0.1']), /special-use/u);
  });

  test('resolver contract asks for every address and does not cache results', async () => {
    const calls = [];
    const fakeLookup = async (...args) => {
      calls.push(args);
      return [{ address: '8.8.8.8', family: 4 }];
    };
    assert.deepEqual(await resolveHostAddresses('hooks.zapier.com', fakeLookup), ['8.8.8.8']);
    assert.deepEqual(await resolveHostAddresses('hooks.zapier.com', fakeLookup), ['8.8.8.8']);
    assert.deepEqual(calls, [
      ['hooks.zapier.com', { all: true, verbatim: true }],
      ['hooks.zapier.com', { all: true, verbatim: true }],
    ]);
  });

  test('HTTPS transport pins the validated address and refuses a later private resolution', async () => {
    let resolutionCalls = 0;
    const resolveHost = async () => {
      resolutionCalls += 1;
      return resolutionCalls === 1 ? ['8.8.8.8'] : ['169.254.169.254'];
    };
    const requests = [];
    const requestImpl = (url, options, onResponse) => {
      const handlers = {};
      const record = { url, options, body: null, timeout: null };
      requests.push(record);
      return {
        setTimeout(milliseconds, callback) {
          record.timeout = milliseconds;
          record.timeoutCallback = callback;
        },
        once(event, callback) { handlers[event] = callback; },
        end(body) {
          record.body = body;
          onResponse({ statusCode: 204, destroy() {} });
        },
        destroy(error) { handlers.error?.(error); },
      };
    };
    const request = {
      url: 'https://hooks.zapier.com/hooks/catch/123/opaque',
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
      timeoutMs: 5_000,
      resolveHost,
      requestImpl,
    };
    assert.deepEqual(await postApprovedJson(request), { status: 204 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.servername, 'hooks.zapier.com');
    assert.equal(requests[0].timeout, 5_000);
    await new Promise((resolve, reject) => {
      requests[0].options.lookup('hooks.zapier.com', {}, (error, address, family) => {
        if (error) reject(error);
        else {
          assert.equal(address, '8.8.8.8');
          assert.equal(family, 4);
          resolve();
        }
      });
    });
    await new Promise((resolve, reject) => {
      requests[0].options.lookup('hooks.zapier.com', { all: true }, (error, addresses) => {
        if (error) reject(error);
        else {
          assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]);
          resolve();
        }
      });
    });
    await assert.rejects(postApprovedJson(request), /special-use address set/u);
    assert.equal(resolutionCalls, 2);
    assert.equal(requests.length, 1);
  });

  test('resolver rejects site-local and IPv4-compatible IPv6 before transport', async () => {
    for (const address of ['fec0::1', 'feff::1', '::127.0.0.1']) {
      let requestCalls = 0;
      await assert.rejects(postApprovedJson({
        url: 'https://hooks.zapier.com/hooks/catch/123/opaque',
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
        timeoutMs: 5_000,
        resolveHost: async () => [address],
        requestImpl() {
          requestCalls += 1;
          throw new Error('transport must not be called');
        },
      }), /special-use address set/u, address);
      assert.equal(requestCalls, 0, address);
    }
  });

  test('HTTPS transport replaces hostile authority and body-length headers without following redirects', async () => {
    let captured;
    let requestCalls = 0;
    const body = '{"message":"Привет"}';
    const requestImpl = (url, options, onResponse) => {
      requestCalls += 1;
      captured = { url, options, sentBody: null };
      return {
        setTimeout() {},
        once() {},
        end(sentBody) {
          captured.sentBody = sentBody;
          onResponse({ statusCode: 307, headers: { location: 'https://evil.example/' }, destroy() {} });
        },
        destroy() {},
      };
    };

    assert.deepEqual(await postApprovedJson({
      url: 'https://hooks.zapier.com/hooks/catch/123/opaque',
      headers: {
        Host: '169.254.169.254',
        hOsT: 'evil.example',
        'Content-Length': '999999',
        'CONTENT-LENGTH': '1',
        'content-type': 'application/json',
      },
      body,
      timeoutMs: 5_000,
      resolveHost: async () => ['8.8.8.8'],
      requestImpl,
    }), { status: 307 });

    assert.equal(requestCalls, 1);
    assert.equal(captured.url, 'https://hooks.zapier.com/hooks/catch/123/opaque');
    assert.deepEqual({ ...captured.options.headers }, {
      'content-type': 'application/json',
      host: 'hooks.zapier.com',
      'content-length': Buffer.byteLength(body),
    });
    assert.equal(captured.options.servername, 'hooks.zapier.com');
    assert.equal(captured.sentBody, body);
  });
});
