#!/usr/bin/env node
// Prints a fresh P-256 private JWK with a kid, for the OAuthSigningKey secret.
import { generateKeyPair, exportJWK, calculateJwkThumbprint } from "jose";

const { privateKey } = await generateKeyPair("ES256", { extractable: true });
const jwk = await exportJWK(privateKey);
jwk.kid = (await calculateJwkThumbprint(jwk, "sha256")).slice(0, 16);
jwk.alg = "ES256";
jwk.use = "sig";
process.stdout.write(JSON.stringify(jwk));
