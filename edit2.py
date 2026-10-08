import json
cmd=None
for line in open('/root/.claude/projects/-home-user/eea3b1a4-1b81-58ff-8271-68ebc1a59828.jsonl'):
    try: o=json.loads(line)
    except: continue
    c=(o.get('message') or {}).get('content')
    if isinstance(c,list):
        for b in c:
            if isinstance(b,dict) and b.get('type')=='tool_use':
                t=b.get('input',{}).get('command','')
                if t.startswith("cd /home/user/judaica-stam && python3 - <<'EOF'") and 'syncPersonalBtn' in t:
                    cmd=t
start=cmd.index("<<'EOF'\n")+len("<<'EOF'\n"); end=cmd.index("\nEOF\n")
py=cmd[start:end]
a='rep("""loadList(); loadSummary();\n</script>""","""loadList(); loadSummary();\n'
assert a in py
py=py.replace(a,'rep("""  .observe(document.body, { childList: true, subtree: true });\n</script>""","""  .observe(document.body, { childList: true, subtree: true });\n',1)
open('edit2.py','w').write(py)