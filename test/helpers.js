// Shared test helpers (real WebCrypto keys so push encryption really runs).
const b64u = buf => Buffer.from(buf).toString("base64url");

export async function testVapidEnv() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { VAPID_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey("jwk", kp.privateKey)) };
}

export async function fakeSubscription(n) {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return {
    endpoint: `https://push.example/${n}`,
    keys: { p256dh: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) },
  };
}

