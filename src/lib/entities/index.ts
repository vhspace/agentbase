import { Service } from "electrodb";
import { UserEntity } from "./user.js";
import { KnowledgeEntity } from "./knowledge.js";
import { JtiCacheEntity } from "./jti.js";
import {
  OAuthClientEntity,
  AuthRequestEntity,
  AuthCodeEntity,
  RefreshTokenEntity,
  GithubIdentityEntity,
} from "./oauth.js";

export const AgentbaseService = new Service({
  user: UserEntity,
  knowledge: KnowledgeEntity,
  jtiCache: JtiCacheEntity,
  oauthClient: OAuthClientEntity,
  authRequest: AuthRequestEntity,
  authCode: AuthCodeEntity,
  refreshToken: RefreshTokenEntity,
  githubIdentity: GithubIdentityEntity,
});

export {
  UserEntity,
  KnowledgeEntity,
  JtiCacheEntity,
  OAuthClientEntity,
  AuthRequestEntity,
  AuthCodeEntity,
  RefreshTokenEntity,
  GithubIdentityEntity,
};
