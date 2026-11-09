import { Service } from "electrodb";
import { UserEntity } from "./user.js";
import { KnowledgeEntity } from "./knowledge.js";
import { JtiCacheEntity } from "./jti.js";
import {
  OAuthClientEntity,
  AuthCodeEntity,
  RefreshTokenEntity,
} from "./oauth.js";

export const AgentbaseService = new Service({
  user: UserEntity,
  knowledge: KnowledgeEntity,
  jtiCache: JtiCacheEntity,
  oauthClient: OAuthClientEntity,
  authCode: AuthCodeEntity,
  refreshToken: RefreshTokenEntity,
});

export {
  UserEntity,
  KnowledgeEntity,
  JtiCacheEntity,
  OAuthClientEntity,
  AuthCodeEntity,
  RefreshTokenEntity,
};
