import type { AppSyncResolverEvent } from "aws-lambda";
import { ulid } from "ulidx";
import { logger, metrics, MetricUnit } from "../../lib/powertools.js";
import { UserEntity } from "../../lib/entities/user.js";
import { computeFingerprint, validatePublicKey } from "../../lib/auth/keys.js";
import { AppError } from "../../lib/errors.js";
import type { RegisterUserInput } from "../../lib/types.js";

const USERNAME_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

export async function handler(
  event: AppSyncResolverEvent<{ input: RegisterUserInput }>,
) {
  const { input } = event.arguments;
  const { username, publicKey, currentTask, longTermGoal } = input;

  // Validate username
  if (!USERNAME_RE.test(username)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Username must be 3-32 chars, lowercase alphanumeric and hyphens, cannot start or end with hyphen",
    );
  }

  // Validate public key
  if (!validatePublicKey(publicKey)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Public key must be an EC P-256 JWK with kty, crv, x, and y fields",
    );
  }

  const fingerprint = await computeFingerprint(publicKey);

  // Check username uniqueness
  const { data: existingByUsername } = await UserEntity.query
    .byUsername({ username })
    .go();
  if (existingByUsername.length > 0) {
    throw new AppError("VALIDATION_ERROR", "Username already taken");
  }

  // Check public key uniqueness
  const { data: existingByKey } = await UserEntity.query
    .byFingerprint({ publicKeyFingerprint: fingerprint })
    .go();
  if (existingByKey.length > 0) {
    throw new AppError("VALIDATION_ERROR", "Public key already registered");
  }

  // Extract geo and request metadata from headers
  const headers = event.request?.headers ?? {};
  const signupIp =
    headers["x-forwarded-for"]?.split(",")[0]?.trim() ??
    headers["cloudfront-viewer-address"]?.split(":")[0] ??
    "unknown";
  const signupCountry = headers["cloudfront-viewer-country"] ?? undefined;
  const signupCity = headers["cloudfront-viewer-city"] ?? undefined;
  const signupRegion = headers["cloudfront-viewer-country-region"] ?? undefined;
  const signupUserAgent = headers["user-agent"] ?? undefined;

  const now = new Date().toISOString();
  const userId = ulid();

  const user = {
    userId,
    username,
    publicKey,
    publicKeyFingerprint: fingerprint,
    signupIp,
    signupCountry,
    signupCity,
    signupRegion,
    signupDate: now,
    signupUserAgent,
    currentTask,
    longTermGoal,
    createdAt: now,
    updatedAt: now,
  };

  await UserEntity.create(user).go();

  metrics.addMetric("UserSignup", MetricUnit.Count, 1);
  if (signupCountry) metrics.addMetadata("country", signupCountry);

  logger.info("User registered", {
    userId,
    username,
    signupIp,
    signupCountry,
    signupCity,
    signupUserAgent,
  });

  // Return user without publicKey internals
  const { publicKey: _, ...publicUser } = user;
  return publicUser;
}
