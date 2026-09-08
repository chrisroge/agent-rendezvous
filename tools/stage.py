#!/usr/bin/env python3
"""Start an isolated loopback stage. Secrets stay in .stage/env.json (0600), never stdout."""
import os, json, pathlib, secrets, subprocess, sys, urllib.request, time
ROOT = pathlib.Path(__file__).resolve().parent.parent
os.chdir(ROOT)
folder = ROOT / '.stage'; folder.mkdir(mode=0o700, exist_ok=True)
envfile = folder / 'env.json'
def aws_secret(name):
 try:
  r = subprocess.run(['aws','secretsmanager','get-secret-value','--region','us-east-2','--secret-id',name,'--query','SecretString','--output','text'],capture_output=True,text=True)
 except FileNotFoundError:return {}
 return json.loads(r.stdout) if r.returncode == 0 else {}
if not envfile.exists():
 result=subprocess.run(['podman','exec','rvz-pg','createdb','-U','rvz','rendezvous_stage'],capture_output=True,text=True)
 if result.returncode and 'already exists' not in result.stderr:raise SystemExit(result.stderr)
 env = {'APP_ENV':'staging','HOST':'127.0.0.1','PORT':'18080','PUBLIC_URL':'http://127.0.0.1:18080','DATABASE_URL':'postgres://rvz:rvz@localhost:5433/rendezvous_stage','DB_SSL':'disable','OPERATOR_TOKEN':secrets.token_urlsafe(36),'MAIL_TRANSPORT':'capture','MAIL_FROM':'Stage <stage@example.invalid>','AMBASSADOR_ENABLED':'false','JUNE_ENABLED':'false','REPRESENTATIVE_ENABLED':'false','REPRESENTATIVE_NETWORK_URL':'http://127.0.0.1:18080/mcp','ANTHROPIC_API_KEY':aws_secret('rendezvous/ambassador').get('anthropic_api_key','')}
 fd=os.open(envfile,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as f:json.dump(env,f)
env=json.loads(envfile.read_text())
st=aws_secret('rendezvous/staging/stripe')
if st.get('secret_key'):
 if not st['secret_key'].startswith(('sk_test_','rk_test_')):raise SystemExit('Refusing non-test Stripe credential')
 for source,target in [('secret_key','STRIPE_SECRET_KEY'),('webhook_secret','STRIPE_WEBHOOK_SECRET'),('price_id','STRIPE_PRICE_ID'),('represented_price_id','STRIPE_REPRESENTED_PRICE_ID')]:
  if st.get(source):env[target]=st[source]
 envfile.write_text(json.dumps(env));envfile.chmod(0o600)
if len(sys.argv)>1 and sys.argv[1]=='run':
 child={k:v for k,v in os.environ.items() if not k.startswith(('STRIPE_','MAIL_','ANTHROPIC_','DATABASE_','DB_','JUNE_','AMBASSADOR_','REPRESENTATIVE_'))};child.update(env)
 raise SystemExit(subprocess.call(sys.argv[2:],env=child))
try:
 urllib.request.urlopen(env['PUBLIC_URL']+'/healthz',timeout=2)
 print('Stage already listening at '+env['PUBLIC_URL']);sys.exit(0)
except Exception:pass
child={k:v for k,v in os.environ.items() if not k.startswith(('STRIPE_','MAIL_','ANTHROPIC_','DATABASE_','DB_','JUNE_','AMBASSADOR_','REPRESENTATIVE_'))};child.update(env)
log=open(folder/'server.log','a')
p=subprocess.Popen(['node','node_modules/tsx/dist/cli.mjs','src/index.ts'],env=child,stdout=log,stderr=log,start_new_session=True)
(folder/'server.pid').write_text(str(p.pid))
for _ in range(30):
 try:
  urllib.request.urlopen(env['PUBLIC_URL']+'/healthz',timeout=1);print('Stage ready: '+env['PUBLIC_URL']+' (loopback only, captured email, dedicated database)');break
 except Exception:time.sleep(1)
else:raise SystemExit('Stage failed to start; inspect .stage/server.log')
