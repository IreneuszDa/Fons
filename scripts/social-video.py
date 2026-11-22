"""Resolve one public post with yt-dlp and stream one bounded file into the caller's temp directory."""
import ipaddress
import json
import socket
import sys
from urllib.parse import urlsplit

from yt_dlp import YoutubeDL
from yt_dlp.networking import Request

platform, post_url, expected_id, destination, byte_limit, time_limit = sys.argv[1:]
domains = {
    "tiktok": ("tiktok.com", "tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "tiktokv.com", "muscdn.com"),
    "instagram": ("instagram.com", "instagr.am", "cdninstagram.com", "fbcdn.net"),
}[platform]


def allowed_host(host):
    return isinstance(host, str) and any(host == d or host.endswith("." + d) for d in domains)


def guard_network(event, args):
    # Applies to redirects and the actual socket, including a changed DNS answer.
    if event == "socket.getaddrinfo" and not allowed_host(args[0]):
        raise PermissionError("unexpected host")
    if event == "socket.connect":
        sock, address = args
        if sock.family not in (socket.AF_INET, socket.AF_INET6) or address[1] != 443:
            raise PermissionError("unexpected destination")
        ip = ipaddress.ip_address(address[0])
        if not ip.is_global or ip.is_multicast:
            raise PermissionError("non-public address")


def run():
    key = "TikTok" if platform == "tiktok" else "Instagram"
    options = {
        "quiet": True, "no_warnings": True, "cachedir": False, "proxy": "",
        "socket_timeout": 8, "retries": 0, "extractor_retries": 0, "noplaylist": True,
        "playlistend": 1, "format": "best[protocol=https][ext=mp4]/best[protocol=https]",
    }
    sys.addaudithook(guard_network)
    with YoutubeDL(options) as downloader:
        info = downloader.extract_info(post_url, ie_key=key, download=False)
        if info.get("id") != expected_id or info.get("extractor_key") != key or info.get("_type") == "playlist":
            return {"status": "unsupported"}
        if info.get("is_live") or info.get("availability") not in (None, "public", "unlisted"):
            return {"status": "unavailable"}
        duration = info.get("duration")
        if (duration or 0) > int(time_limit) or (info.get("filesize") or 0) > int(byte_limit):
            return {"status": "too_large"}
        url = urlsplit(info["url"])
        if url.scheme != "https" or not allowed_host(url.hostname) or url.username or url.password or url.port:
            return {"status": "unavailable"}
        with downloader.urlopen(Request(info["url"], headers=info.get("http_headers"))) as response:
            declared = int(response.headers.get("Content-Length") or 0)
            if declared > int(byte_limit):
                return {"status": "too_large"}
            size = 0
            with open(destination, "xb") as output:
                while chunk := response.read(128 * 1024):
                    size += len(chunk)
                    if size > int(byte_limit):
                        return {"status": "too_large"}
                    output.write(chunk)
            if declared and size != declared:
                return {"status": "unavailable"}
        return {"status": "ok", "caption": (info.get("description") or "")[:8000],
                "author": (info.get("uploader") or "")[:128], "duration": duration}


try:
    print(json.dumps(run()))
except Exception:
    print(json.dumps({"status": "unavailable"}))
