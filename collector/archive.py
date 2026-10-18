"""Archive AIS history, camera stills and forecast snapshots for the evidence scrubber."""
import json, os, time, urllib.request, glob

NOW = time.time()
UTC = time.gmtime()

def fetch(url, timeout=30, binary=False):
    req = urllib.request.Request(url, headers={"User-Agent": "NahaLabs-GodsEye/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read() if binary else r.read().decode()

# 1. AIS history (append current snapshot as one jsonl record per run)
try:
    with open("data/vessels-snapshot.json") as f:
        snap = json.load(f)
    os.makedirs("data/ais-history", exist_ok=True)
    day = time.strftime("%Y-%m-%d", UTC)
    rec = {"ts": int(NOW), "captured_at": snap.get("captured_at"),
           "vessels": [{k: v.get(k) for k in ("mmsi", "name", "lat", "lon", "sog", "cog")}
                       for v in snap.get("vessels", [])]}
    with open(f"data/ais-history/{day}.jsonl", "a") as f:
        f.write(json.dumps(rec) + "\n")
    for p in glob.glob("data/ais-history/*.jsonl"):
        if os.path.getmtime(p) < NOW - 7 * 86400:
            os.remove(p)
    print("ais history appended")
except Exception as e:
    print("ais history failed:", e)

# 2. Camera stills, one per hour, 48h retention
CAMS = {
    "vetchs": "https://durbancoastlive.com/incoming/vetchs/vetchs.jpg",
    "bluewaters": "https://durbancoastlive.com/incoming/blueWaters/bwSouth.jpg",
}
for cid, url in CAMS.items():
    try:
        d = f"data/cam/{cid}"
        os.makedirs(d, exist_ok=True)
        slot = int(NOW // 3600)
        path = f"{d}/{slot}.jpg"
        if not os.path.exists(path):
            img = fetch(url, binary=True)
            if len(img) > 5000:
                with open(path, "wb") as f:
                    f.write(img)
        for p in glob.glob(f"{d}/*.jpg"):
            if int(os.path.basename(p).split(".")[0]) < slot - 48:
                os.remove(p)
        print(f"cam {cid} archived")
    except Exception as e:
        print(f"cam {cid} failed:", e)

# 3. Forecast snapshot (issued today), 14d retention
try:
    os.makedirs("data/forecast", exist_ok=True)
    day = time.strftime("%Y-%m-%d", UTC)
    marine = json.loads(fetch(
        "https://marine-api.open-meteo.com/v1/marine?latitude=-29.87&longitude=31.05"
        "&hourly=wave_height,wave_period,swell_wave_height&past_days=2&forecast_days=3&timezone=UTC"))
    wx = json.loads(fetch(
        "https://api.open-meteo.com/v1/forecast?latitude=-29.87&longitude=31.05"
        "&hourly=wind_speed_10m,wind_gusts_10m&wind_speed_unit=kn&past_days=2&forecast_days=3&timezone=UTC"))
    with open(f"data/forecast/{day}.json", "w") as f:
        json.dump({"issued_at": int(NOW), "marine": marine.get("hourly", {}), "wx": wx.get("hourly", {})}, f)
    for p in glob.glob("data/forecast/*.json"):
        if os.path.getmtime(p) < NOW - 14 * 86400:
            os.remove(p)
    print("forecast archived")
except Exception as e:
    print("forecast failed:", e)

# 4. Scrub index
idx = {"generated_at": int(NOW),
       "ais_days": sorted(os.path.basename(p)[:-6] for p in glob.glob("data/ais-history/*.jsonl")),
       "cam": {cid: sorted(int(os.path.basename(p)[:-4]) for p in glob.glob(f"data/cam/{cid}/*.jpg")) for cid in CAMS},
       "forecast_days": sorted(os.path.basename(p)[:-5] for p in glob.glob("data/forecast/*.json"))}
with open("data/scrub-index.json", "w") as f:
    json.dump(idx, f)
print("index written")
