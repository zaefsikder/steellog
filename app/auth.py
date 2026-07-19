"""Authentication: resolve the current user from a request.

In production the frontend sends the Neon Auth access token as
``Authorization: Bearer <jwt>``; we verify its signature against Neon Auth's
JWKS and read the user id from the ``sub`` claim.

In local development (no JWKS URL configured) we fall back to trusting an
``X-Dev-User`` header so the app is usable and its per-user scoping is testable
without standing up Neon Auth. The fallback is impossible once a JWKS URL is
set, so it can never weaken a real deployment.
"""

from __future__ import annotations

from dataclasses import dataclass

import jwt
from fastapi import Depends, Header, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app import config


@dataclass(frozen=True)
class User:
    id: str
    email: str


# JWKS client caches signing keys and refreshes them as needed.
_jwks_client: jwt.PyJWKClient | None = (
    jwt.PyJWKClient(config.NEON_AUTH_JWKS_URL) if config.NEON_AUTH_JWKS_URL else None
)

# Bearer is optional at the dependency level so dev mode can run header-only;
# real deployments enforce its presence below.
_bearer = HTTPBearer(auto_error=False)


def _verify_jwt(token: str) -> User:
    try:
        signing_key = _jwks_client.get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["EdDSA"],  # Neon Auth signs with Ed25519
            audience=config.NEON_AUTH_AUDIENCE,
            issuer=config.NEON_AUTH_ISSUER or None,
            options={"require": ["sub", "exp"]},
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired token") from exc

    return User(id=claims["sub"], email=(claims.get("email") or "").lower())


def current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    x_dev_user: str | None = Header(default=None),
    x_dev_email: str | None = Header(default=None),
) -> User:
    if config.AUTH_DEV_MODE:
        # Local convenience: default to a single local user so the app works
        # without a login screen. Pass X-Dev-User / X-Dev-Email to simulate
        # different accounts (used by the multi-tenant tests). Defaulting the
        # email to OWNER_EMAIL means local dev seeds the starter programs.
        return User(
            id=x_dev_user or "local-dev",
            email=(x_dev_email or config.OWNER_EMAIL or "local@dev").lower(),
        )

    if creds is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return _verify_jwt(creds.credentials)
