import type { AppSyncResolverEvent, AppSyncIdentityLambda } from "aws-lambda";
import { UserEntity } from "../../lib/entities/user.js";
import { AppError } from "../../lib/errors.js";
import type { UpdateUserInput } from "../../lib/types.js";

export async function handler(
  event: AppSyncResolverEvent<{ input: UpdateUserInput }>,
) {
  const identity = event.identity as AppSyncIdentityLambda | null;
  const userId = identity?.resolverContext?.userId;
  if (!userId) {
    throw new AppError("AUTH_FAILED", "Not authenticated");
  }

  const { input } = event.arguments;
  const now = new Date().toISOString();

  const updates: Record<string, unknown> = { updatedAt: now };
  if (input.currentTask !== undefined) updates.currentTask = input.currentTask;
  if (input.longTermGoal !== undefined) updates.longTermGoal = input.longTermGoal;

  const { data: user } = await UserEntity.patch({ userId })
    .set(updates)
    .go({ response: "all_new" });

  const { publicKey: _, ...publicUser } = user;
  return publicUser;
}
