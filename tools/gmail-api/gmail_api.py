import argparse
import base64
import json
import os
from pathlib import Path
from urllib.parse import quote

import requests
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]


def paths():
    root = Path.home() / ".ccm" / "gmail"
    credentials = Path(os.environ.get("CCM_GMAIL_CREDENTIALS", root / "credentials.json"))
    token = Path(os.environ.get("CCM_GMAIL_TOKEN", root / "token.json"))
    return credentials, token


def configure_proxy():
    proxy = (
        os.environ.get("CCM_GMAIL_PROXY")
        or os.environ.get("HTTPS_PROXY")
        or os.environ.get("HTTP_PROXY")
        or os.environ.get("RCLONE_HTTP_PROXY")
    )
    if proxy:
        os.environ.setdefault("HTTPS_PROXY", proxy)
        os.environ.setdefault("HTTP_PROXY", proxy)

    no_proxy = [item.strip() for item in os.environ.get("NO_PROXY", "").split(",") if item.strip()]
    for host in ("localhost", "127.0.0.1"):
        if host not in no_proxy:
            no_proxy.append(host)
    os.environ["NO_PROXY"] = ",".join(no_proxy)


def auth():
    configure_proxy()
    credentials_path, token_path = paths()
    creds = None
    if token_path.exists():
        creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
    if not creds or not creds.valid:
        if not credentials_path.exists():
            raise RuntimeError(f"Gmail OAuth credentials not found: {credentials_path}")
        token_path.parent.mkdir(parents=True, exist_ok=True)
        flow = InstalledAppFlow.from_client_secrets_file(str(credentials_path), SCOPES)
        oauth_port = int(os.environ.get("CCM_GMAIL_OAUTH_PORT", "0"))
        open_browser = os.environ.get("CCM_GMAIL_OPEN_BROWSER", "1").lower() not in {
            "0", "false", "no",
        }
        auth_kwargs = {}
        if os.environ.get("CCM_GMAIL_OAUTH_PROMPT"):
            auth_kwargs["prompt"] = os.environ["CCM_GMAIL_OAUTH_PROMPT"]
        if os.environ.get("CCM_GMAIL_LOGIN_HINT"):
            auth_kwargs["login_hint"] = os.environ["CCM_GMAIL_LOGIN_HINT"]
        creds = flow.run_local_server(
            port=oauth_port,
            open_browser=open_browser,
            **auth_kwargs,
        )
    token_path.parent.mkdir(parents=True, exist_ok=True)
    token_path.write_text(creds.to_json(), encoding="utf-8")
    return creds


def headers(payload):
    return {h["name"].lower(): h["value"] for h in payload.get("headers", [])}


def body_text(payload):
    data = payload.get("body", {}).get("data")
    if data and payload.get("mimeType", "").startswith("text/"):
        return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8", "replace")
    for part in payload.get("parts", []):
        if part.get("mimeType") == "text/plain":
            value = body_text(part)
            if value:
                return value
    return ""


def gmail_request(creds, method, path, *, params=None):
    url = f"https://gmail.googleapis.com/gmail/v1/users/me/{path.lstrip('/')}"
    response = requests.request(
        method,
        url,
        params=params,
        headers={"Authorization": f"Bearer {creds.token}"},
        timeout=30,
    )
    if response.status_code == 401 and creds.refresh_token:
        creds.refresh(Request())
        _, token_path = paths()
        token_path.write_text(creds.to_json(), encoding="utf-8")
        response = requests.request(
            method,
            url,
            params=params,
            headers={"Authorization": f"Bearer {creds.token}"},
            timeout=30,
        )
    response.raise_for_status()
    return response.json()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("action", choices=["profile", "search", "read"])
    p.add_argument("--query")
    p.add_argument("--message-id")
    p.add_argument("--max-results", type=int, default=20)
    args = p.parse_args()
    creds = auth()
    if args.action == "profile":
        result = gmail_request(creds, "GET", "profile")
    elif args.action == "search":
        if not args.query:
            p.error("--query is required for search")
        listed = gmail_request(
            creds,
            "GET",
            "messages",
            params={"q": args.query, "maxResults": args.max_results},
        )
        result = {"resultSizeEstimate": listed.get("resultSizeEstimate", 0), "messages": listed.get("messages", [])}
    else:
        if not args.message_id:
            p.error("--message-id is required for read")
        msg = gmail_request(
            creds,
            "GET",
            f"messages/{quote(args.message_id, safe='')}",
            params={"format": "full"},
        )
        h = headers(msg.get("payload", {}))
        result = {
            "id": msg.get("id"), "threadId": msg.get("threadId"), "labelIds": msg.get("labelIds", []),
            "date": h.get("date"), "from": h.get("from"), "to": h.get("to"), "subject": h.get("subject"),
            "snippet": msg.get("snippet"), "body_text": body_text(msg.get("payload", {})),
        }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
