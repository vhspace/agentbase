import { Entity } from "electrodb";
import { docClient, tableName } from "../db.js";

export const UserEntity = new Entity(
  {
    model: {
      entity: "user",
      version: "1",
      service: "agentbase",
    },
    attributes: {
      userId: { type: "string", required: true },
      username: { type: "string", required: true },
      // Keypair accounts have a public key; accounts created through OAuth
      // login may not, so both are optional and the fingerprint index is sparse.
      publicKey: { type: "any" }, // JWK stored as map
      publicKeyFingerprint: { type: "string" },
      githubId: { type: "string" },
      githubLogin: { type: "string" },
      signupIp: { type: "string" },
      signupCountry: { type: "string" },
      signupCity: { type: "string" },
      signupRegion: { type: "string" },
      signupDate: { type: "string", required: true },
      signupUserAgent: { type: "string" },
      currentTask: { type: "string" },
      longTermGoal: { type: "string" },
      createdAt: { type: "string", required: true },
      updatedAt: { type: "string", required: true },
    },
    indexes: {
      byUserId: {
        pk: { field: "pk", composite: ["userId"] },
        sk: { field: "sk", composite: [] },
      },
      byUsername: {
        index: "gsi1pk-gsi1sk-index",
        pk: { field: "gsi1pk", composite: ["username"] },
        sk: { field: "gsi1sk", composite: [] },
      },
      byFingerprint: {
        index: "gsi2pk-gsi2sk-index",
        pk: { field: "gsi2pk", composite: ["publicKeyFingerprint"] },
        sk: { field: "gsi2sk", composite: [] },
      },
    },
  },
  { client: docClient, table: tableName },
);
