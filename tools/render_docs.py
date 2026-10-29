# Renders vendor API specs in docs/integrations/raw into markdown references.
# Usage: python3 tools/render_docs.py   (run from repo root)
import json, os, re, html, sys
RAW = "docs/integrations/raw"; OUT = "docs/integrations"

# ---- OpenAPI renderer (FHB) ----
def render_openapi(src, dst):
    import io
    spec=json.load(open(src)); out=open(dst,"w")
    comps=spec.get("components",{})
    def ref(r): 
        parts=r.lstrip("#/").split("/"); n=spec
        for p in parts: n=n[p]
        return n
    def res(s,seen=()):
        if isinstance(s,dict) and "$ref" in s:
            if s["$ref"] in seen: return {"type":"(recursive "+s["$ref"]+")"}
            return res(ref(s["$ref"]),seen+(s["$ref"],))
        return s
    def schema_lines(s,ind=0,name=None,req=False,seen=()):
        s=res(s,seen); L=[]; pad="  "*ind
        if not isinstance(s,dict): return L
        for k in ("allOf","oneOf","anyOf"):
            if k in s:
                L.append(f"{pad}- {name or ''} ({k}):")
                for sub in s[k]: L+=schema_lines(sub,ind+1,None,False,seen)
                return L
        t=s.get("type","object" if "properties" in s else "")
        if s.get("nullable"): t+="|null"
        bits=[t]
        if "enum" in s: bits.append("enum="+",".join(map(str,s["enum"])))
        if "format" in s: bits.append(s["format"])
        for k in ("maxLength","minLength","maximum","minimum","pattern","default","example"):
            if k in s: bits.append(f"{k}={s[k]!r}"[:120])
        d=(s.get("description") or "").replace("\n"," ")
        if name is not None:
            L.append(f"{pad}- `{name}`{' **(required)**' if req else ''}: {' '.join(bits)}{' — '+d if d else ''}")
            ind+=1
        elif d: L.append(f"{pad}  {d}")
        rq=set(s.get("required",[]))
        for pn,ps in (s.get("properties") or {}).items():
            L+=schema_lines(ps,ind,pn,pn in rq,seen)
        if t.startswith("array") and "items" in s:
            L+=schema_lines(s["items"],ind,"[item]",False,seen)
        return L
    out.write(f"# {spec['info']['title']} — full API reference\n\n_Auto-rendered from the vendor OpenAPI spec (raw file alongside). Servers: {spec.get('servers')}_\n\n")
    out.write(spec["info"].get("description","")+"\n\n")
    for t in spec.get("tags",[]):
        out.write(f"\n## Section: {t['name']}\n\n{t.get('description','')}\n\n")
    for k,v in comps.get("securitySchemes",{}).items(): out.write(f"**Auth `{k}`:** {json.dumps(v)}\n\n")
    for p,ops in spec["paths"].items():
        common=ops.get("parameters",[])
        for m,o in ops.items():
            if m not in("get","post","put","patch","delete"): continue
            out.write(f"\n---\n## {m.upper()} `{p}` — {o.get('summary','')}\n\n")
            if o.get("description"): out.write(o["description"]+"\n\n")
            params=[res(x) for x in common+o.get("parameters",[])]
            if params:
                out.write("**Parameters**\n\n")
                for x in params:
                    sc=res(x.get("schema",{}))
                    out.write(f"- `{x['name']}` ({x['in']}){' **required**' if x.get('required') else ''}: {sc.get('type','')} {('enum='+str(sc['enum'])) if 'enum' in sc else ''} — {(x.get('description') or '').replace(chr(10),' ')}\n")
                out.write("\n")
            rb=res(o.get("requestBody",{}))
            for ct,c in (rb.get("content") or {}).items():
                out.write(f"**Request body** ({ct})\n\n"+"\n".join(schema_lines(c.get("schema",{})))+"\n\n")
                ex=c.get("example") or next(iter((c.get("examples") or {}).values()),{}).get("value") if c.get("examples") else c.get("example")
                if ex: out.write("Example:\n```json\n"+json.dumps(ex,indent=1,ensure_ascii=False)[:4000]+"\n```\n\n")
            for code,r in (o.get("responses") or {}).items():
                r=res(r); out.write(f"**Response {code}** — {(r.get('description') or '').replace(chr(10),' ')}\n\n")
                for ct,c in (r.get("content") or {}).items():
                    ls=schema_lines(c.get("schema",{}))
                    if ls: out.write("\n".join(ls)+"\n\n")
                    ex=c.get("example")
                    if not ex and c.get("examples"):
                        ex={k:v.get("value") for k,v in c["examples"].items()}
                    if ex: out.write("```json\n"+json.dumps(ex,indent=1,ensure_ascii=False)[:3000]+"\n```\n\n")
    out.close()

# ---- Postman renderer (euShipments) ----
def render_postman(src, dst):
    c=json.load(open(src)); out=open(dst,"w")
    def md(s):
        s=s or ""
        s=re.sub(r"<img[^>]*>","",s)
        s=re.sub(r"</?(strong|b)>","**",s); s=re.sub(r"</?code>","`",s)
        s=re.sub(r"<li>","\n- ",s); s=re.sub(r"</t[dh]>"," | ",s); s=re.sub(r"<tr>","\n| ",s)
        s=re.sub(r"<(br|/p|/div|/h\d|/ul|/table)[^>]*>","\n",s); s=re.sub(r"<h(\d)[^>]*>",lambda m:"\n"+"#"*(int(m.group(1))+2)+" ",s)
        s=re.sub(r"<[^>]+>","",s); s=html.unescape(s)
        return re.sub(r"\n{3,}","\n\n",s).strip()
    out.write("# euShipments (inout.bg) — full API reference\n\n_Auto-rendered from the vendor Postman collection (raw file alongside)._\n\n"+md(c["info"].get("description"))+"\n")
    def walk(items,d=2):
        for it in items:
            if "item" in it:
                out.write(f"\n{'#'*d} {it['name']}\n\n{md(it.get('description'))}\n"); walk(it["item"],d+1); continue
            r=it["request"]; u=r["url"]["raw"] if isinstance(r["url"],dict) else r["url"]
            out.write(f"\n---\n{'#'*d} {it['name']}\n\n`{r['method']} {u}`\n\n")
            h=[f"{x['key']}: {x.get('value','')}" for x in r.get("header",[]) if not x.get("disabled")]
            if h: out.write("Headers: "+"; ".join(h)+"\n\n")
            if isinstance(r["url"],dict):
                for q in r["url"].get("query",[]) or []: out.write(f"- query `{q['key']}`={q.get('value','')} {md(q.get('description',''))}\n")
                for q in r["url"].get("variable",[]) or []: out.write(f"- path `{q['key']}` {md(q.get('description',''))}\n")
            out.write("\n"+md(r.get("description"))+"\n\n")
            b=r.get("body") or {}
            if b.get("raw"): out.write("Request body:\n```json\n"+b["raw"].strip()+"\n```\n\n")
            elif b.get(b.get("mode") or "", None): out.write(f"Body ({b['mode']}): "+json.dumps(b[b['mode']],ensure_ascii=False)[:3000]+"\n\n")
            for resp in it.get("response",[]):
                out.write(f"Example response — {resp.get('name')} ({resp.get('code')}):\n```json\n{(resp.get('body') or '').strip()[:4000]}\n```\n\n")
    walk(c["item"])
    out.close()

if __name__ == "__main__":
    render_openapi(f"{RAW}/fhb-kika-v3.openapi.json", f"{OUT}/fhb-kika-v3.md")
    render_openapi(f"{RAW}/fhb-joy.openapi.json", f"{OUT}/fhb-joy.md")
    render_postman(f"{RAW}/eushipments.postman_collection.json", f"{OUT}/eushipments.md")
    print("rendered 3 references")
