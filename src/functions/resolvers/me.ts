import type { AppSyncResolverEvent, AppSyncIdentityLambda } from "aws-lambda";
import { UserEntity } from "../../lib/entities/user.js";
import { AppError } from "../../lib/errors.js";

export async function handler(event: AppSyncResolverEvent<never>) {
  const identity = event.identity as AppSyncIdentityLambda | null;
  const userId = identity?.resolverContext?.userId;
  if (!userId) {
    throw new AppError("AUTH_FAILED", "Not authenticated");
  }

  const { data: user } = await UserEntity.get({ userId }).go();
  if (!user) {
    throw new AppError("NOT_FOUND", "User not found");
  }

  const { publicKey: _, ...publicUser } = user;
  return publicUser;
}
