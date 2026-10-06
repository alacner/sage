import * as https from 'node:https';
import * as tls from 'node:tls';
import { X509Certificate, createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { relayCertificateOrigin, validateRelayCertificatePolicy, type RelayCertificatePolicy, type RelayCertificateProbe } from '../shared/relay-certificate';
/** Only explicitly resolved relay providers receive this transport. */
export interface RelayTransport {
    origin: string;
    certificate?: RelayCertificatePolicy;
}
const certificateEpochs = new Map<string, number>();
const activeCertificateRequests = new Map<string, Set<import('node:http').ClientRequest>>();
const policyKey = (p: RelayCertificatePolicy) => `${p.origin}:${p.sha256}`;
/** Revoke in-flight pinned HTTP and existing SDK delegates when desktop trust changes. */
export function invalidateRelayCertificate(policy?: RelayCertificatePolicy): void {
    if (!policy)
        return;
    const key = policyKey(policy);
    certificateEpochs.set(key, (certificateEpochs.get(key) ?? 0) + 1);
    for (const request of activeCertificateRequests.get(key) ?? [])
        request.destroy(Error('Relay certificate trust changed'));
    activeCertificateRequests.delete(key);
}
const fingerprint = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');
const host = (origin: string) => new URL(origin).hostname.replace(/^\[|\]$/g, '');
function verifyCertificate(cert: X509Certificate, origin: string, now = Date.now()): void {
    if (!Number.isFinite(Date.parse(cert.validFrom)) || now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo))
        throw Error('Relay certificate is not currently valid');
    const hostname = host(origin);
    if (!(isIP(hostname) ? cert.checkIP(hostname) : cert.checkHost(hostname)))
        throw Error('Relay certificate does not match the hostname');
}
/** Persistence checks structure, identity and PEM/pin agreement; expiry is enforced on every connection. */
export function validateDesktopRelayCertificate(value: unknown): asserts value is RelayCertificatePolicy {
    validateRelayCertificatePolicy(value);
    if (!value.certificatePem || (value.certificatePem.match(/-----BEGIN CERTIFICATE-----/g)?.length !== 1))
        throw Error('Relay trust requires one public leaf certificate');
    const cert = new X509Certificate(value.certificatePem);
    if (fingerprint(cert.raw) !== value.sha256)
        throw Error('Relay certificate fingerprint does not match the public certificate');
    const hostname = host(value.origin);
    if (!(isIP(hostname) ? cert.checkIP(hostname) : cert.checkHost(hostname)))
        throw Error('Relay certificate does not match the hostname');
}
export function relayTlsOptions(url: string, policy?: RelayCertificatePolicy): tls.ConnectionOptions {
    if (!policy)
        return { minVersion: 'TLSv1.2', rejectUnauthorized: true };
    validateDesktopRelayCertificate(policy);
    if (relayCertificateOrigin(url) !== policy.origin)
        throw Error('Relay certificate trust belongs to another origin');
    verifyCertificate(new X509Certificate(policy.certificatePem!), policy.origin);
    return {
        minVersion: 'TLSv1.2', rejectUnauthorized: true,
        ca: [...tls.rootCertificates, policy.certificatePem!],
        // Explicitly approved leaves also cover a private CA chain, without trusting that CA for other leaves.
        allowPartialTrustChain: true,
        // Every new connection verifies the leaf, even when the certificate chains to a public CA.
        checkServerIdentity(hostname, peer) {
            const identity = tls.checkServerIdentity(hostname, peer);
            if (identity)
                return identity;
            try {
                if (!peer.raw || fingerprint(peer.raw) !== policy.sha256)
                    throw Error('Relay certificate changed; review its fingerprint before trusting it');
                verifyCertificate(new X509Certificate(peer.raw), policy.origin);
                return undefined;
            }
            catch (error) {
                return error as Error;
            }
        },
    };
}
/** No application request or credential is sent. Inspection never changes trust. */
export async function probeRelayCertificate(raw: string): Promise<RelayCertificateProbe> {
    const origin = relayCertificateOrigin(raw);
    const url = new URL(origin), hostname = host(origin);
    return new Promise((resolve, reject) => {
        const socket = tls.connect({ host: hostname, port: Number(url.port || 443), servername: isIP(hostname) ? undefined : hostname, minVersion: 'TLSv1.2', rejectUnauthorized: false });
        const timer = setTimeout(() => socket.destroy(Error('Relay certificate inspection timed out')), 8000);
        let settled = false;
        const finish = () => { settled = true; clearTimeout(timer); socket.destroy(); };
        socket.once('close', () => { if (!settled) {
            finish();
            reject(Error('Relay closed before certificate inspection completed'));
        } });
        socket.once('error', error => { finish(); reject(error); });
        socket.once('secureConnect', () => {
            try {
                const peer = socket.getPeerCertificate();
                if (!peer.raw)
                    throw Error('Relay did not provide a certificate');
                const cert = new X509Certificate(peer.raw);
                verifyCertificate(cert, origin);
                const result = { origin, sha256: fingerprint(cert.raw), certificatePem: cert.toString(), subject: cert.subject, issuer: cert.issuer, validFrom: new Date(cert.validFrom).toISOString(), validTo: new Date(cert.validTo).toISOString() };
                finish();
                resolve(result);
            }
            catch (error) {
                finish();
                reject(error);
            }
        });
    });
}
/** Scoped fetch keeps streaming/backpressure and cancellation, without a global trust override. */
export function relayFetch(transport?: RelayTransport, delegate: typeof fetch = fetch): typeof fetch {
    if (!transport)
        return delegate;
    const key = transport.certificate ? policyKey(transport.certificate) : undefined;
    const epoch = key ? certificateEpochs.get(key) ?? 0 : 0;
    return async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
        if (url.username || url.password)
            throw Error('Relay URLs cannot contain credentials');
        const request = new Request(input, init);
        if (url.origin !== transport.origin || url.username || url.password)
            throw Error('Relay request escaped its configured origin');
        request.signal.throwIfAborted();
        if (key && (certificateEpochs.get(key) ?? 0) !== epoch)
            throw Error('Relay certificate trust changed; reconnect before sending again');
        if (!transport.certificate)
            return delegate(input, { ...init, redirect: 'error' });
        const options = relayTlsOptions(request.url, transport.certificate);
        return new Promise<Response>((resolve, reject) => {
            const headers = Object.fromEntries(request.headers.entries());
            // Node HTTPS does not add fetch's encoding negotiation; still decode server compression below.
            headers['accept-encoding'] = 'identity';
            const req = https.request(url, { ...options, agent: false, method: request.method, headers }, res => {
                try {
                    if (res.statusCode! >= 300 && res.statusCode! < 400) {
                        res.destroy();
                        reject(Error('Relay redirects are not allowed'));
                        return;
                    }
                    const responseHeaders = new Headers();
                    for (const [key, value] of Object.entries(res.headers))
                        for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value])
                            responseHeaders.append(key, v);
                    let body: Readable = res;
                    const encoding = responseHeaders.get('content-encoding');
                    const decode = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
                    if (decode) {
                        res.once('error', error => decode.destroy(error));
                        decode.once('close', () => { if (!res.readableEnded)
                            res.destroy(); });
                        body = res.pipe(decode);
                        responseHeaders.delete('content-encoding');
                        responseHeaders.delete('content-length');
                    }
                    const empty = request.method === 'HEAD' || [204, 205, 304].includes(res.statusCode!);
                    if (empty)
                        res.resume();
                    resolve(new Response(empty ? null : Readable.toWeb(body) as ReadableStream<Uint8Array>, { status: res.statusCode!, statusText: res.statusMessage, headers: responseHeaders }));
                }
                catch (error) {
                    res.destroy();
                    reject(error);
                }
            });
            req.once('upgrade', (_response, socket) => { socket.destroy(); reject(Error('Unexpected relay HTTP upgrade')); });
            if (key) {
                let active = activeCertificateRequests.get(key);
                if (!active)
                    activeCertificateRequests.set(key, active = new Set());
                active.add(req);
            }
            const abort = () => req.destroy(request.signal.reason instanceof Error ? request.signal.reason : Error('Relay request aborted'));
            request.signal.addEventListener('abort', abort, { once: true });
            req.once('error', reject);
            req.once('close', () => { request.signal.removeEventListener('abort', abort); if (key) {
                const active = activeCertificateRequests.get(key);
                active?.delete(req);
                if (!active?.size)
                    activeCertificateRequests.delete(key);
            } });
            if (request.signal.aborted) {
                abort();
                return;
            }
            if (request.body) {
                const body = Readable.fromWeb(request.body as import('node:stream/web').ReadableStream<Uint8Array>);
                body.once('error', error => req.destroy(error));
                req.once('error', () => body.destroy());
                body.pipe(req);
            }
            else
                req.end();
        });
    };
}
