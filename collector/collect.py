"""Collect AIS positions around Durban + Richards Bay for N seconds and refresh the snapshot."""
import json, os, sys, threading, time
import websocket

KEY = os.environ["AIS_KEY"]
RUN = int(sys.argv[1]) if len(sys.argv) > 1 else 150
BOXES = [[[-30.3, 30.7], [-29.4, 31.5]], [[-29.2, 31.8], [-28.4, 32.5]]]
PATH = "data/vessels-snapshot.json"

ships = {}
def on_open(ws):
    ws.send(json.dumps({"APIKey": KEY, "BoundingBoxes": BOXES,
                        "FilterMessageTypes": ["PositionReport", "ShipStaticData"]}))
def on_message(ws, raw):
    try: m = json.loads(raw)
    except Exception: return
    meta = m.get("MetaData", {})
    mmsi = str(meta.get("MMSI") or "")
    if not mmsi: return
    s = ships.setdefault(mmsi, {"mmsi": mmsi})
    if meta.get("ShipName"): s["name"] = meta["ShipName"].strip()
    if m.get("MessageType") == "PositionReport":
        p = m["Message"]["PositionReport"]
        s.update(lat=p.get("Latitude"), lon=p.get("Longitude"), sog=p.get("Sog"),
                 cog=p.get("Cog"), t=time.time())
    elif m.get("MessageType") == "ShipStaticData":
        d = m["Message"]["ShipStaticData"]
        s["type"] = d.get("Type")
def on_error(ws, e):
    print("upstream error:", e, file=sys.stderr)

ws = websocket.WebSocketApp("wss://stream.aisstream.io/v0/stream",
                            on_open=on_open, on_message=on_message, on_error=on_error)
t = threading.Thread(target=ws.run_forever, kwargs={"ping_interval": 20})
t.daemon = True
t.start()
time.sleep(RUN)
ws.close()

existing = {}
try:
    with open(PATH) as f:
        for v in json.load(f).get("vessels", []):
            existing[str(v.get("mmsi"))] = v
except FileNotFoundError:
    pass
now = time.time()
for mmsi, s in ships.items():
    existing[mmsi] = s
cut = now - 45 * 60
merged = [v for v in existing.values()
          if v.get("lat") is not None and (v.get("t", now) >= cut)]
for v in merged:
    v.pop("t", None)
with open(PATH, "w") as f:
    json.dump({"captured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "vessels": merged}, f)
print(f"collected={len(ships)} merged={len(merged)}")
