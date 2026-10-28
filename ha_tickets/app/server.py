"""Tickets Board - add-on Home Assistant façon Monday.

Backend aiohttp + SQLite. Sert l'interface (static/) via Ingress et expose une API JSON.
"""
import asyncio
import datetime as dt
import json
import logging
import os
import re
import sqlite3
import uuid

import aiohttp
from aiohttp import web

DATA_DIR = os.environ.get("DATA_DIR", "/data")
PHOTO_DIR = os.path.join(DATA_DIR, "photos")
DB_PATH = os.path.join(DATA_DIR, "tickets.db")
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
PORT = int(os.environ.get("PORT", "8099"))
SUPERVISOR_TOKEN = os.environ.get("SUPERVISOR_TOKEN")
HA_API = "http://supervisor/core/api"
# Ingress : seules les requêtes du Supervisor sont acceptées (sauf mode dev)
ALLOWED_IPS = {"172.30.32.2", "127.0.0.1", "::1"}
DEV = os.environ.get("TICKETS_DEV") == "1"
MAX_DEPTH = 5

COLUMN_TYPES = {"text", "number", "status", "dropdown", "date", "person", "checkbox", "link", "photo"}
GROUP_COLORS = ["#579bfc", "#00c875", "#fdab3d", "#e2445c", "#a25ddc", "#037f4c", "#ff642e", "#66ccff"]

log = logging.getLogger("tickets")
os.makedirs(PHOTO_DIR, exist_ok=True)


def load_log_level():
    try:
        with open(os.path.join(DATA_DIR, "options.json")) as f:
            return json.load(f).get("log_level", "info").upper()
    except Exception:
        return "INFO"


logging.basicConfig(level=load_log_level(), format="%(asctime)s %(levelname)s %(message)s")

# --------------------------------------------------------------------------- DB

db = sqlite3.connect(DB_PATH, check_same_thread=False)
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys = ON")
db.executescript(
    """
CREATE TABLE IF NOT EXISTS boards(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  position REAL DEFAULT 0, created TEXT);
CREATE TABLE IF NOT EXISTS columns(
  id INTEGER PRIMARY KEY, board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL, type TEXT NOT NULL, settings TEXT DEFAULT '{}', position REAL DEFAULT 0,
  width INTEGER DEFAULT 150);
CREATE TABLE IF NOT EXISTS groups_(
  id INTEGER PRIMARY KEY, board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL, color TEXT, position REAL DEFAULT 0, collapsed INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS items(
  id INTEGER PRIMARY KEY, board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
  name TEXT NOT NULL, vals TEXT DEFAULT '{}', position REAL DEFAULT 0, created TEXT, updated TEXT);
CREATE TABLE IF NOT EXISTS item_updates(
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  text TEXT, author TEXT, ts TEXT);
CREATE TABLE IF NOT EXISTS automations(
  id INTEGER PRIMARY KEY, board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT, enabled INTEGER DEFAULT 1, trig TEXT, conditions TEXT DEFAULT '[]',
  actions TEXT DEFAULT '[]', created TEXT);
CREATE TABLE IF NOT EXISTS automation_log(
  id INTEGER PRIMARY KEY, automation_id INTEGER, board_id INTEGER, item_id INTEGER,
  ts TEXT, ok INTEGER, message TEXT);
CREATE TABLE IF NOT EXISTS date_fired(
  automation_id INTEGER, item_id INTEGER, key TEXT,
  PRIMARY KEY(automation_id, item_id, key));
"""
)
db.commit()


def now_iso():
    return dt.datetime.now().isoformat(timespec="seconds")


def q(sql, args=()):
    return [dict(r) for r in db.execute(sql, args).fetchall()]


def q1(sql, args=()):
    r = db.execute(sql, args).fetchone()
    return dict(r) if r else None


def ex(sql, args=()):
    cur = db.execute(sql, args)
    db.commit()
    return cur.lastrowid


def col_row(c):
    c["settings"] = json.loads(c.get("settings") or "{}")
    return c


def item_row(i):
    i["values"] = json.loads(i.pop("vals") or "{}")
    return i


def auto_row(a):
    a["trigger"] = json.loads(a.pop("trig") or "{}")
    a["conditions"] = json.loads(a["conditions"] or "[]")
    a["actions"] = json.loads(a["actions"] or "[]")
    a["enabled"] = bool(a["enabled"])
    return a


def get_columns(board_id):
    return [col_row(c) for c in q("SELECT * FROM columns WHERE board_id=? ORDER BY position, id", (board_id,))]


def get_item(item_id):
    i = q1("SELECT * FROM items WHERE id=?", (item_id,))
    return item_row(i) if i else None


def board_state(board_id):
    board = q1("SELECT * FROM boards WHERE id=?", (board_id,))
    if not board:
        raise web.HTTPNotFound(text="Tableau introuvable")
    items = [item_row(i) for i in q("SELECT * FROM items WHERE board_id=? ORDER BY position, id", (board_id,))]
    counts = {r["item_id"]: r["n"] for r in q(
        "SELECT item_id, COUNT(*) n FROM item_updates WHERE item_id IN (SELECT id FROM items WHERE board_id=?) GROUP BY item_id",
        (board_id,))}
    for i in items:
        i["updates_count"] = counts.get(i["id"], 0)
    return {
        "board": board,
        "columns": get_columns(board_id),
        "groups": q("SELECT * FROM groups_ WHERE board_id=? ORDER BY position, id", (board_id,)),
        "items": items,
        "automations_count": q1("SELECT COUNT(*) n FROM automations WHERE board_id=?", (board_id,))["n"],
    }


def next_pos(table, where, args):
    r = q1(f"SELECT MAX(position) m FROM {table} WHERE {where}", args)
    return (r["m"] or 0) + 1


DEFAULT_STATUS = [
    {"id": "s1", "label": "À faire", "color": "#c4c4c4"},
    {"id": "s2", "label": "En cours", "color": "#fdab3d"},
    {"id": "s3", "label": "Bloqué", "color": "#e2445c"},
    {"id": "s4", "label": "Terminé", "color": "#00c875"},
]


def create_board(name, template=True):
    bid = ex("INSERT INTO boards(name, position, created) VALUES(?,?,?)",
             (name, next_pos("boards", "1=1", ()), now_iso()))
    if template:
        add_column(bid, "Responsable", "person", {})
        add_column(bid, "Statut", "status", {"options": DEFAULT_STATUS, "done": "s4"})
        add_column(bid, "Échéance", "date", {})
        g1 = add_group(bid, "À traiter", "#579bfc")
        add_group(bid, "Terminé", "#00c875")
        ex("INSERT INTO items(board_id, group_id, name, vals, position, created, updated) VALUES(?,?,?,?,?,?,?)",
           (bid, g1, "Mon premier ticket", "{}", 1, now_iso(), now_iso()))
    return bid


def add_column(board_id, name, ctype, settings):
    if ctype not in COLUMN_TYPES:
        raise web.HTTPBadRequest(text="Type de colonne inconnu")
    if ctype in ("status", "dropdown") and not settings.get("options"):
        settings["options"] = DEFAULT_STATUS if ctype == "status" else []
        if ctype == "status":
            settings.setdefault("done", "s4")
    width = {"text": 180, "status": 140, "photo": 110, "checkbox": 90, "number": 110}.get(ctype, 150)
    return ex("INSERT INTO columns(board_id, name, type, settings, position, width) VALUES(?,?,?,?,?,?)",
              (board_id, name, ctype, json.dumps(settings), next_pos("columns", "board_id=?", (board_id,)), width))


def add_group(board_id, name, color=None):
    if not color:
        n = q1("SELECT COUNT(*) n FROM groups_ WHERE board_id=?", (board_id,))["n"]
        color = GROUP_COLORS[n % len(GROUP_COLORS)]
    return ex("INSERT INTO groups_(board_id, name, color, position) VALUES(?,?,?,?)",
              (board_id, name, color, next_pos("groups_", "board_id=?", (board_id,))))


# ------------------------------------------------------------- valeurs / rendu

def display_value(col, val):
    """Valeur lisible (pour templates, comparaisons de libellés)."""
    if val is None or val == "":
        return ""
    t = col["type"]
    if t in ("status", "dropdown"):
        for o in col["settings"].get("options", []):
            if o["id"] == val:
                return o["label"]
        return ""
    if t == "checkbox":
        return "oui" if val else "non"
    if t == "link":
        if isinstance(val, dict):
            return val.get("url", "")
        return str(val)
    if t == "photo":
        return str(len(val)) + " photo(s)" if isinstance(val, list) else ""
    if t == "date" and isinstance(val, str) and re.match(r"\d{4}-\d{2}-\d{2}", val):
        y, m, d = val[:10].split("-")
        return f"{d}/{m}/{y}" + (" " + val[11:16] if len(val) > 10 else "")
    if isinstance(val, float) and val.is_integer():
        return str(int(val))
    return str(val)


def norm(val):
    """Normalisation pour comparaisons de déclencheurs/conditions."""
    if val is None:
        return ""
    if isinstance(val, bool):
        return "true" if val else "false"
    if isinstance(val, float) and val.is_integer():
        return str(int(val))
    if isinstance(val, dict):
        return val.get("url", "")
    if isinstance(val, list):
        return str(len(val))
    return str(val)


def render_template(text, item, columns, board=None, group=None):
    if not text:
        return ""
    board = board or q1("SELECT * FROM boards WHERE id=?", (item["board_id"],))
    group = group or q1("SELECT * FROM groups_ WHERE id=?", (item["group_id"],))
    by_name = {c["name"].lower(): c for c in columns}

    def repl(m):
        key = m.group(1).strip()
        k = key.lower()
        if k in ("item", "element", "élément", "nom", "ticket"):
            return item["name"]
        if k in ("board", "tableau"):
            return board["name"] if board else ""
        if k in ("group", "groupe"):
            return group["name"] if group else ""
        if k == "id":
            return str(item["id"])
        if k in ("date", "aujourdhui", "today"):
            return dt.date.today().strftime("%d/%m/%Y")
        if k in by_name:
            c = by_name[k]
            return display_value(c, item["values"].get(str(c["id"])))
        return m.group(0)

    return re.sub(r"\{([^{}]+)\}", repl, text)


def coerce_value(col, value, item=None, columns=None):
    """Convertit une valeur saisie (ou issue d'une action d'automatisation)."""
    t = col["type"]
    if value is None or value == "":
        return None
    if t == "number":
        try:
            return float(str(value).replace(",", "."))
        except ValueError:
            return None
    if t == "checkbox":
        if isinstance(value, bool):
            return value
        return str(value).lower() in ("1", "true", "oui", "yes", "on")
    if t == "date":
        s = str(value).strip().lower()
        if s in ("today", "aujourdhui", "aujourd'hui"):
            return dt.date.today().isoformat()
        m = re.fullmatch(r"([+-]\d+)", s)
        if m:
            return (dt.date.today() + dt.timedelta(days=int(m.group(1)))).isoformat()
        return str(value)
    if t == "text" and item is not None and columns is not None:
        return render_template(str(value), item, columns)
    if t == "photo":
        return value if isinstance(value, list) else None
    return value


# --------------------------------------------------------------- Home Assistant

_session = None


async def ha_request(method, path, payload=None):
    if not SUPERVISOR_TOKEN:
        raise RuntimeError("API Home Assistant indisponible (SUPERVISOR_TOKEN absent)")
    global _session
    if _session is None:
        _session = aiohttp.ClientSession()
    headers = {"Authorization": f"Bearer {SUPERVISOR_TOKEN}", "Content-Type": "application/json"}
    async with _session.request(method, HA_API + path, headers=headers, json=payload,
                                timeout=aiohttp.ClientTimeout(total=15)) as r:
        txt = await r.text()
        if r.status >= 400:
            raise RuntimeError(f"HA {r.status}: {txt[:200]}")
        try:
            return json.loads(txt) if txt else None
        except ValueError:
            return txt


async def ha_call_service(service, data):
    if "." not in service:
        raise RuntimeError(f"Service invalide : {service}")
    domain, name = service.split(".", 1)
    return await ha_request("POST", f"/services/{domain}/{name}", data)


# ------------------------------------------------------------- automatisations

def write_log(auto, item_id, ok, message):
    ex("INSERT INTO automation_log(automation_id, board_id, item_id, ts, ok, message) VALUES(?,?,?,?,?,?)",
       (auto["id"], auto["board_id"], item_id, now_iso(), 1 if ok else 0, message))
    ex("DELETE FROM automation_log WHERE id NOT IN (SELECT id FROM automation_log ORDER BY id DESC LIMIT 500)")


def check_conditions(conditions, item, columns):
    cols = {str(c["id"]): c for c in columns}
    for cond in conditions or []:
        if cond.get("column_id") == "group":
            actual = str(item["group_id"])
        else:
            col = cols.get(str(cond.get("column_id")))
            if not col:
                continue
            actual = norm(item["values"].get(str(col["id"])))
        op = cond.get("op", "eq")
        expected = norm(cond.get("value"))
        if op == "eq" and actual != expected:
            return False
        if op == "neq" and actual == expected:
            return False
        if op == "empty" and actual not in ("", "false", "0"):
            return False
        if op == "not_empty" and actual in ("", "false", "0"):
            return False
        if op == "contains" and expected.lower() not in actual.lower():
            return False
    return True


def trigger_matches(trig, event, info):
    t = trig.get("type")
    if t != event:
        return False
    if t == "column_changed":
        if str(trig.get("column_id")) != str(info.get("column_id")):
            return False
        want = trig.get("value")
        if want not in (None, "", "__any__"):
            return norm(info.get("new")) == norm(want)
        return True
    if t == "moved_to_group":
        return str(trig.get("group_id")) == str(info.get("group_id"))
    return True


async def run_event(board_id, item_id, event, info=None, depth=0):
    if depth > MAX_DEPTH:
        log.warning("Profondeur d'automatisation max atteinte (boucle ?)")
        return
    info = info or {}
    autos = [auto_row(a) for a in q("SELECT * FROM automations WHERE board_id=? AND enabled=1", (board_id,))]
    for a in autos:
        if not trigger_matches(a["trigger"], event, info):
            continue
        item = get_item(item_id)
        if not item:
            return
        columns = get_columns(board_id)
        if not check_conditions(a["conditions"], item, columns):
            continue
        await execute_actions(a, item_id, depth)


async def execute_actions(auto, item_id, depth=0):
    board_id = auto["board_id"]
    done = []
    for act in auto["actions"]:
        item = get_item(item_id)
        if not item:
            break
        columns = get_columns(board_id)
        cols = {str(c["id"]): c for c in columns}
        t = act.get("type")
        try:
            if t == "set_column":
                col = cols.get(str(act.get("column_id")))
                if not col:
                    raise RuntimeError("colonne introuvable")
                await set_values(item_id, {str(col["id"]): act.get("value")}, depth + 1, from_auto=True)
                done.append(f"{col['name']} modifié")
            elif t == "move_to_group":
                await move_item(item_id, int(act["group_id"]), None, depth + 1)
                done.append("déplacé")
            elif t == "notify":
                svc = act.get("service") or "notify.notify"
                if not svc.startswith("notify."):
                    svc = "notify." + svc
                data = {"message": render_template(act.get("message") or "{item}", item, columns),
                        "title": render_template(act.get("title") or "", item, columns)}
                if not data["title"]:
                    data.pop("title")
                await ha_call_service(svc, data)
                done.append(f"notification {svc}")
            elif t == "persistent_notification":
                await ha_call_service("persistent_notification.create", {
                    "title": render_template(act.get("title") or "Tickets", item, columns),
                    "message": render_template(act.get("message") or "{item}", item, columns)})
                done.append("notification HA")
            elif t == "ha_service":
                data = json.loads(act.get("data") or "{}")

                def deep(v):
                    if isinstance(v, str):
                        return render_template(v, item, columns)
                    if isinstance(v, list):
                        return [deep(x) for x in v]
                    if isinstance(v, dict):
                        return {k: deep(x) for k, x in v.items()}
                    return v
                await ha_call_service(act["service"], deep(data))
                done.append(f"service {act['service']}")
            elif t == "fire_event":
                ev = act.get("event") or "ha_tickets"
                payload = {
                    "item_id": item["id"], "item": item["name"], "board_id": board_id,
                    "board": (q1("SELECT name FROM boards WHERE id=?", (board_id,)) or {}).get("name"),
                    "group": (q1("SELECT name FROM groups_ WHERE id=?", (item["group_id"],)) or {}).get("name"),
                    "automation": auto.get("name"),
                    "values": {c["name"]: display_value(c, item["values"].get(str(c["id"]))) for c in columns},
                }
                await ha_request("POST", f"/events/{ev}", payload)
                done.append(f"événement {ev}")
            elif t == "add_update":
                ex("INSERT INTO item_updates(item_id, text, author, ts) VALUES(?,?,?,?)",
                   (item_id, render_template(act.get("text") or "", item, columns), "⚡ Automatisation", now_iso()))
                done.append("commentaire ajouté")
            elif t == "duplicate_item":
                await duplicate_item(item_id, act.get("group_id"))
                done.append("dupliqué")
            elif t == "delete_item":
                delete_item(item_id)
                done.append("supprimé")
                break
        except Exception as e:  # noqa
            log.exception("Action %s en erreur", t)
            write_log(auto, item_id, False, f"{t} : {e}")
            continue
    if done:
        write_log(auto, item_id, True, ", ".join(done))


async def set_values(item_id, changes, depth=0, from_auto=False):
    item = get_item(item_id)
    if not item:
        raise web.HTTPNotFound()
    columns = get_columns(item["board_id"])
    cols = {str(c["id"]): c for c in columns}
    vals = item["values"]
    changed = []
    for cid, v in changes.items():
        col = cols.get(str(cid))
        if not col:
            continue
        nv = coerce_value(col, v, item if from_auto else None, columns if from_auto else None)
        old = vals.get(str(cid))
        if norm(old) == norm(nv) and type(old) is type(nv):
            continue
        if nv is None:
            vals.pop(str(cid), None)
        else:
            vals[str(cid)] = nv
        changed.append((str(cid), old, nv))
    if changed:
        ex("UPDATE items SET vals=?, updated=? WHERE id=?", (json.dumps(vals), now_iso(), item_id))
        for cid, old, nv in changed:
            await run_event(item["board_id"], item_id, "column_changed",
                            {"column_id": cid, "old": old, "new": nv}, depth)


async def move_item(item_id, group_id, index=None, depth=0):
    item = get_item(item_id)
    if not item:
        raise web.HTTPNotFound()
    grp = q1("SELECT * FROM groups_ WHERE id=? AND board_id=?", (group_id, item["board_id"]))
    if not grp:
        raise web.HTTPBadRequest(text="Groupe invalide")
    ids = [r["id"] for r in q("SELECT id FROM items WHERE group_id=? AND id<>? ORDER BY position, id",
                              (group_id, item_id))]
    if index is None or index > len(ids):
        index = len(ids)
    ids.insert(max(0, int(index)), item_id)
    for pos, iid in enumerate(ids):
        db.execute("UPDATE items SET position=?, group_id=? WHERE id=?", (pos, group_id, iid))
    db.execute("UPDATE items SET updated=? WHERE id=?", (now_iso(), item_id))
    db.commit()
    if item["group_id"] != group_id:
        await run_event(item["board_id"], item_id, "moved_to_group", {"group_id": group_id}, depth)


async def create_item(group_id, name, values=None, depth=0):
    g = q1("SELECT * FROM groups_ WHERE id=?", (group_id,))
    if not g:
        raise web.HTTPNotFound(text="Groupe introuvable")
    iid = ex("INSERT INTO items(board_id, group_id, name, vals, position, created, updated) VALUES(?,?,?,?,?,?,?)",
             (g["board_id"], group_id, name or "Nouvel élément", json.dumps(values or {}),
              next_pos("items", "group_id=?", (group_id,)), now_iso(), now_iso()))
    await run_event(g["board_id"], iid, "item_created", {}, depth)
    return iid


async def duplicate_item(item_id, group_id=None):
    item = get_item(item_id)
    vals = {k: v for k, v in item["values"].items() if not isinstance(v, list)}
    return ex("INSERT INTO items(board_id, group_id, name, vals, position, created, updated) VALUES(?,?,?,?,?,?,?)",
              (item["board_id"], int(group_id) if group_id else item["group_id"], item["name"] + " (copie)",
               json.dumps(vals), item["position"] + 0.5, now_iso(), now_iso()))


def delete_item_photos(item):
    cols = {str(c["id"]): c for c in get_columns(item["board_id"])}
    for cid, v in item["values"].items():
        if cols.get(cid, {}).get("type") == "photo" and isinstance(v, list):
            for f in v:
                p = os.path.join(PHOTO_DIR, os.path.basename(f))
                if os.path.exists(p):
                    os.remove(p)


def delete_item(item_id):
    item = get_item(item_id)
    if item:
        delete_item_photos(item)
        ex("DELETE FROM items WHERE id=?", (item_id,))


async def date_scheduler():
    """Vérifie chaque minute les automatisations basées sur une date."""
    await asyncio.sleep(5)
    while True:
        try:
            await check_date_automations()
        except Exception:
            log.exception("Erreur planificateur de dates")
        await asyncio.sleep(60)


async def check_date_automations():
    now = dt.datetime.now()
    today = now.date()
    autos = [auto_row(a) for a in q("SELECT * FROM automations WHERE enabled=1")]
    for a in autos:
        trig = a["trigger"]
        if trig.get("type") != "date_arrived":
            continue
        cid = str(trig.get("column_id"))
        offset = int(trig.get("offset_days") or 0)
        at = trig.get("time") or "09:00"
        try:
            hh, mm = [int(x) for x in at.split(":")[:2]]
        except ValueError:
            hh, mm = 9, 0
        created = (a.get("created") or "2000-01-01")[:10]
        columns = get_columns(a["board_id"])
        for item in [item_row(i) for i in q("SELECT * FROM items WHERE board_id=?", (a["board_id"],))]:
            raw = item["values"].get(cid)
            if not raw or not isinstance(raw, str):
                continue
            try:
                d = dt.date.fromisoformat(raw[:10])
            except ValueError:
                continue
            fire_day = d + dt.timedelta(days=offset)
            fire_at = dt.datetime.combine(fire_day, dt.time(hh, mm))
            if fire_at > now or fire_day.isoformat() < created or (today - fire_day).days > 7:
                continue
            key = f"{raw}|{offset}|{at}"
            if q1("SELECT 1 FROM date_fired WHERE automation_id=? AND item_id=? AND key=?", (a["id"], item["id"], key)):
                continue
            ex("INSERT OR IGNORE INTO date_fired(automation_id, item_id, key) VALUES(?,?,?)", (a["id"], item["id"], key))
            if check_conditions(a["conditions"], item, columns):
                await execute_actions(a, item["id"])


# ------------------------------------------------------------------- HTTP API

routes = web.RouteTableDef()


@web.middleware
async def guard(request, handler):
    if not DEV and request.remote not in ALLOWED_IPS:
        return web.Response(status=403, text="Accès réservé à l'Ingress Home Assistant")
    try:
        return await handler(request)
    except web.HTTPException:
        raise
    except Exception as e:
        log.exception("Erreur API")
        return web.json_response({"error": str(e)}, status=500)


def current_user(request):
    return (request.headers.get("X-Remote-User-Display-Name")
            or request.headers.get("X-Remote-User-Name") or "Moi")


@routes.get("/")
async def index(request):
    return web.FileResponse(os.path.join(STATIC_DIR, "index.html"),
                            headers={"Cache-Control": "no-cache"})


@routes.get("/api/me")
async def me(request):
    return web.json_response({"name": current_user(request), "ha": bool(SUPERVISOR_TOKEN)})


# Tableaux
@routes.get("/api/boards")
async def list_boards(request):
    return web.json_response(q("SELECT * FROM boards ORDER BY position, id"))


@routes.post("/api/boards")
async def new_board(request):
    body = await request.json()
    bid = create_board(body.get("name") or "Nouveau tableau", body.get("template", True))
    return web.json_response({"id": bid})


@routes.get("/api/boards/{id}")
async def get_board(request):
    return web.json_response(board_state(int(request.match_info["id"])))


@routes.patch("/api/boards/{id}")
async def patch_board(request):
    body = await request.json()
    bid = int(request.match_info["id"])
    for f in ("name", "description"):
        if f in body:
            ex(f"UPDATE boards SET {f}=? WHERE id=?", (body[f], bid))
    return web.json_response({"ok": True})


@routes.delete("/api/boards/{id}")
async def del_board(request):
    bid = int(request.match_info["id"])
    for it in [item_row(i) for i in q("SELECT * FROM items WHERE board_id=?", (bid,))]:
        delete_item_photos(it)
    ex("DELETE FROM boards WHERE id=?", (bid,))
    return web.json_response({"ok": True})


@routes.post("/api/boards/{id}/duplicate")
async def dup_board(request):
    bid = int(request.match_info["id"])
    st = board_state(bid)
    nb = create_board(st["board"]["name"] + " (copie)", template=False)
    cmap, gmap = {}, {}
    for c in st["columns"]:
        cmap[str(c["id"])] = str(add_column(nb, c["name"], c["type"], c["settings"]))
    for g in st["groups"]:
        gmap[g["id"]] = add_group(nb, g["name"], g["color"])
    for i in st["items"]:
        vals = {cmap[k]: v for k, v in i["values"].items() if k in cmap and not isinstance(v, list)}
        ex("INSERT INTO items(board_id, group_id, name, vals, position, created, updated) VALUES(?,?,?,?,?,?,?)",
           (nb, gmap[i["group_id"]], i["name"], json.dumps(vals), i["position"], now_iso(), now_iso()))
    return web.json_response({"id": nb})


@routes.post("/api/boards/order")
async def order_boards(request):
    body = await request.json()
    for pos, bid in enumerate(body.get("ids", [])):
        db.execute("UPDATE boards SET position=? WHERE id=?", (pos, bid))
    db.commit()
    return web.json_response({"ok": True})


# Colonnes
@routes.post("/api/boards/{id}/columns")
async def new_column(request):
    body = await request.json()
    cid = add_column(int(request.match_info["id"]), body.get("name") or "Colonne",
                     body.get("type", "text"), body.get("settings") or {})
    return web.json_response({"id": cid})


@routes.patch("/api/columns/{id}")
async def patch_column(request):
    body = await request.json()
    cid = int(request.match_info["id"])
    if "name" in body:
        ex("UPDATE columns SET name=? WHERE id=?", (body["name"], cid))
    if "width" in body:
        ex("UPDATE columns SET width=? WHERE id=?", (int(body["width"]), cid))
    if "settings" in body:
        ex("UPDATE columns SET settings=? WHERE id=?", (json.dumps(body["settings"]), cid))
    return web.json_response({"ok": True})


@routes.delete("/api/columns/{id}")
async def del_column(request):
    cid = int(request.match_info["id"])
    col = q1("SELECT * FROM columns WHERE id=?", (cid,))
    if col:
        for it in [item_row(i) for i in q("SELECT * FROM items WHERE board_id=?", (col["board_id"],))]:
            v = it["values"].pop(str(cid), None)
            if col["type"] == "photo" and isinstance(v, list):
                for f in v:
                    p = os.path.join(PHOTO_DIR, os.path.basename(f))
                    if os.path.exists(p):
                        os.remove(p)
            db.execute("UPDATE items SET vals=? WHERE id=?", (json.dumps(it["values"]), it["id"]))
        db.execute("DELETE FROM columns WHERE id=?", (cid,))
        db.commit()
    return web.json_response({"ok": True})


@routes.post("/api/boards/{id}/columns/order")
async def order_columns(request):
    body = await request.json()
    for pos, cid in enumerate(body.get("ids", [])):
        db.execute("UPDATE columns SET position=? WHERE id=? AND board_id=?",
                   (pos, cid, int(request.match_info["id"])))
    db.commit()
    return web.json_response({"ok": True})


# Groupes
@routes.post("/api/boards/{id}/groups")
async def new_group(request):
    body = await request.json()
    gid = add_group(int(request.match_info["id"]), body.get("name") or "Nouveau groupe", body.get("color"))
    if body.get("top"):
        db.execute("UPDATE groups_ SET position=? WHERE id=?", (-1, gid))
        db.commit()
    return web.json_response({"id": gid})


@routes.patch("/api/groups/{id}")
async def patch_group(request):
    body = await request.json()
    gid = int(request.match_info["id"])
    for f in ("name", "color", "collapsed"):
        if f in body:
            ex(f"UPDATE groups_ SET {f}=? WHERE id=?", (body[f], gid))
    return web.json_response({"ok": True})


@routes.delete("/api/groups/{id}")
async def del_group(request):
    gid = int(request.match_info["id"])
    for it in [item_row(i) for i in q("SELECT * FROM items WHERE group_id=?", (gid,))]:
        delete_item_photos(it)
    ex("DELETE FROM groups_ WHERE id=?", (gid,))
    return web.json_response({"ok": True})


@routes.post("/api/boards/{id}/groups/order")
async def order_groups(request):
    body = await request.json()
    for pos, gid in enumerate(body.get("ids", [])):
        db.execute("UPDATE groups_ SET position=? WHERE id=? AND board_id=?",
                   (pos, gid, int(request.match_info["id"])))
    db.commit()
    return web.json_response({"ok": True})


# Éléments
@routes.post("/api/groups/{id}/items")
async def new_item(request):
    body = await request.json()
    iid = await create_item(int(request.match_info["id"]), body.get("name"), body.get("values"))
    return web.json_response({"id": iid})


@routes.get("/api/items/{id}")
async def read_item(request):
    it = get_item(int(request.match_info["id"]))
    if not it:
        raise web.HTTPNotFound()
    it["updates"] = q("SELECT * FROM item_updates WHERE item_id=? ORDER BY id DESC", (it["id"],))
    return web.json_response(it)


@routes.patch("/api/items/{id}")
async def patch_item(request):
    body = await request.json()
    iid = int(request.match_info["id"])
    if "name" in body:
        ex("UPDATE items SET name=?, updated=? WHERE id=?", (body["name"] or "Sans titre", now_iso(), iid))
    if "values" in body:
        await set_values(iid, body["values"])
    if "group_id" in body:
        await move_item(iid, int(body["group_id"]), body.get("index"))
    return web.json_response({"ok": True})


@routes.delete("/api/items/{id}")
async def del_item(request):
    delete_item(int(request.match_info["id"]))
    return web.json_response({"ok": True})


@routes.post("/api/items/{id}/duplicate")
async def dup_item(request):
    return web.json_response({"id": await duplicate_item(int(request.match_info["id"]))})


@routes.post("/api/items/{id}/updates")
async def add_update(request):
    body = await request.json()
    iid = int(request.match_info["id"])
    ex("INSERT INTO item_updates(item_id, text, author, ts) VALUES(?,?,?,?)",
       (iid, body.get("text", ""), current_user(request), now_iso()))
    return web.json_response({"ok": True})


@routes.delete("/api/updates/{id}")
async def del_update(request):
    ex("DELETE FROM item_updates WHERE id=?", (int(request.match_info["id"]),))
    return web.json_response({"ok": True})


# Photos
@routes.post("/api/items/{id}/photos/{col}")
async def upload_photo(request):
    iid = int(request.match_info["id"])
    cid = request.match_info["col"]
    item = get_item(iid)
    if not item:
        raise web.HTTPNotFound()
    col = q1("SELECT * FROM columns WHERE id=? AND board_id=?", (cid, item["board_id"]))
    if not col or col["type"] != "photo":
        raise web.HTTPBadRequest(text="Colonne photo invalide")
    reader = await request.multipart()
    added = []
    while True:
        part = await reader.next()
        if part is None:
            break
        if part.name != "file":
            continue
        ext = os.path.splitext(part.filename or "")[1].lower() or ".jpg"
        if ext not in (".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic"):
            ext = ".jpg"
        fname = f"{uuid.uuid4().hex}{ext}"
        with open(os.path.join(PHOTO_DIR, fname), "wb") as f:
            while True:
                chunk = await part.read_chunk()
                if not chunk:
                    break
                f.write(chunk)
        added.append(fname)
    photos = list(item["values"].get(cid) or []) + added
    await set_values(iid, {cid: photos})
    return web.json_response({"files": added})


@routes.delete("/api/items/{id}/photos/{col}/{file}")
async def delete_photo(request):
    iid = int(request.match_info["id"])
    cid = request.match_info["col"]
    fname = os.path.basename(request.match_info["file"])
    item = get_item(iid)
    photos = [p for p in (item["values"].get(cid) or []) if p != fname]
    p = os.path.join(PHOTO_DIR, fname)
    if os.path.exists(p):
        os.remove(p)
    await set_values(iid, {cid: photos or None})
    return web.json_response({"ok": True})


@routes.get("/photos/{file}")
async def get_photo(request):
    p = os.path.join(PHOTO_DIR, os.path.basename(request.match_info["file"]))
    if not os.path.exists(p):
        raise web.HTTPNotFound()
    return web.FileResponse(p, headers={"Cache-Control": "max-age=31536000"})


# Automatisations
@routes.get("/api/boards/{id}/automations")
async def list_autos(request):
    bid = int(request.match_info["id"])
    return web.json_response({
        "automations": [auto_row(a) for a in q("SELECT * FROM automations WHERE board_id=? ORDER BY id", (bid,))],
        "log": q("SELECT l.*, a.name automation, i.name item FROM automation_log l "
                 "LEFT JOIN automations a ON a.id=l.automation_id LEFT JOIN items i ON i.id=l.item_id "
                 "WHERE l.board_id=? ORDER BY l.id DESC LIMIT 50", (bid,)),
    })


def auto_fields(body):
    return (body.get("name") or "Automatisation", 1 if body.get("enabled", True) else 0,
            json.dumps(body.get("trigger") or {}), json.dumps(body.get("conditions") or []),
            json.dumps(body.get("actions") or []))


@routes.post("/api/boards/{id}/automations")
async def new_auto(request):
    body = await request.json()
    aid = ex("INSERT INTO automations(name, enabled, trig, conditions, actions, board_id, created) VALUES(?,?,?,?,?,?,?)",
             auto_fields(body) + (int(request.match_info["id"]), now_iso()))
    return web.json_response({"id": aid})


@routes.put("/api/automations/{id}")
async def put_auto(request):
    body = await request.json()
    ex("UPDATE automations SET name=?, enabled=?, trig=?, conditions=?, actions=? WHERE id=?",
       auto_fields(body) + (int(request.match_info["id"]),))
    return web.json_response({"ok": True})


@routes.patch("/api/automations/{id}")
async def toggle_auto(request):
    body = await request.json()
    ex("UPDATE automations SET enabled=? WHERE id=?", (1 if body.get("enabled") else 0, int(request.match_info["id"])))
    return web.json_response({"ok": True})


@routes.delete("/api/automations/{id}")
async def del_auto(request):
    ex("DELETE FROM automations WHERE id=?", (int(request.match_info["id"]),))
    return web.json_response({"ok": True})


@routes.post("/api/automations/{id}/run/{item}")
async def run_auto(request):
    a = auto_row(q1("SELECT * FROM automations WHERE id=?", (int(request.match_info["id"]),)))
    await execute_actions(a, int(request.match_info["item"]))
    return web.json_response({"ok": True})


# Infos Home Assistant
@routes.get("/api/ha/persons")
async def ha_persons(request):
    try:
        states = await ha_request("GET", "/states")
        persons = [{"id": s["entity_id"], "name": s["attributes"].get("friendly_name", s["entity_id"]),
                    "picture": s["attributes"].get("entity_picture")}
                   for s in states if s["entity_id"].startswith("person.")]
        return web.json_response(persons)
    except Exception as e:
        log.debug("persons: %s", e)
        return web.json_response([])


@routes.get("/api/ha/services")
async def ha_services(request):
    try:
        data = await ha_request("GET", "/services")
        out = []
        for d in data:
            for s in d["services"].keys():
                out.append(f"{d['domain']}.{s}")
        return web.json_response(sorted(out))
    except Exception as e:
        log.debug("services: %s", e)
        return web.json_response([])


async def on_startup(app):
    app["sched"] = asyncio.create_task(date_scheduler())
    if not q1("SELECT id FROM boards LIMIT 1"):
        create_board("Mes tickets")


async def on_cleanup(app):
    app["sched"].cancel()
    if _session:
        await _session.close()


def make_app():
    app = web.Application(middlewares=[guard], client_max_size=30 * 1024 ** 2)
    app.add_routes(routes)
    app.router.add_static("/static/", STATIC_DIR)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


if __name__ == "__main__":
    log.info("Tickets Board démarré sur le port %s", PORT)
    web.run_app(make_app(), host="0.0.0.0", port=PORT, access_log=None)
