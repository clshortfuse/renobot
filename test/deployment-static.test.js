import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const nginx = readFileSync(new URL('../deploy/nginx.conf', import.meta.url), 'utf8');
const deploy = readFileSync(new URL('../deploy/deploy.sh', import.meta.url), 'utf8');
const compose = readFileSync(new URL('../deploy/compose.yaml', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');

describe('public static deployment', () => {
  it('serves only known public paths directly and proxies authentication', () => {
    assert.match(nginx, /root \/opt\/renobot\/public;/u);
    for (const path of ['/', '/app', '/app/modder/kofi', '/assets/site.css', '/assets/site.js']) {
      assert.ok(nginx.includes(`location = ${path} {`), path);
    }
    assert.match(nginx, /location \^~ \/auth\/discord \{[\s\S]*?proxy_pass http:\/\/127\.0\.0\.1:3000;/u);
    assert.match(nginx, /location \/ \{[\s\S]*?proxy_pass http:\/\/127\.0\.0\.1:3000;/u);
    assert.doesNotMatch(nginx, /location \/assets\/ \{|location = \/auth\/session \{[^}]*try_files/u);
  });

  it('overwrites webhook client source at Nginx rather than forwarding user-supplied provenance', () => {
    assert.match(nginx, /location \^~ \/prod\/kofi\/ \{[\s\S]*?proxy_set_header X-Renobot-Client-IP \$remote_addr;[\s\S]*?proxy_set_header X-Renobot-Client-Port \$remote_port;/u);
    assert.match(compose, /127\.0\.0\.1:3000:3000/u);
  });

  it('extracts public files from the selected image before switching the public symlink', () => {
    assert.match(deploy, /docker cp "\$container:\/app\/src\/static\/\." "\$staging\/"/u);
    assert.match(deploy, /docker compose [^\n]*up -d --no-deps --wait app[\s\S]*mv -Tf \/opt\/renobot\/public\.next \/opt\/renobot\/public/u);
    assert.ok(deploy.indexOf('docker cp') < deploy.indexOf('up -d --no-deps --wait app'));
    assert.match(deploy, /\)\s*docker compose --env-file \.deploy\.env\.next[\s\S]*?mkdir -p \/opt\/renobot\/static\/releases/u);
    assert.doesNotMatch(deploy, /^umask 077$/mu);
  });

  it('runs image-pinned migrations before switching the app when a database is configured', () => {
    const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
    assert.match(dockerfile, /COPY prisma \.\/prisma[\s\S]*?RUN npm run db:generate/u);
    assert.match(dockerfile, /COPY --from=dependencies \/app\/node_modules/u);
    assert.match(deploy, /docker compose --env-file \.deploy\.env\.next -f compose\.yaml run --rm --no-deps/u);
    assert.match(deploy, /prisma migrate deploy/u);
    assert.ok(deploy.indexOf('prisma migrate deploy') < deploy.indexOf('up -d --no-deps --wait app'));
    assert.match(compose, /source: \/opt\/renobot\/data\s+target: \/data\s+bind:\s+create_host_path: false/u);
    assert.match(compose, /read_only: true/u);
    assert.match(deploy, /umask 077/u);
    assert.match(deploy, /install -d -m 0700 data/u);
    assert.match(deploy, /chmod g-s data/u);
    assert.match(deploy, /--mount type=bind,src=\/opt\/renobot\/data,dst=\/data/u);
    assert.match(deploy, /stat -c '%u:%g:%a' data/u);
    assert.ok(deploy.indexOf('install -d -m 0700 data') < deploy.indexOf('prisma migrate deploy'));
  });

  it('keeps the payment listener available if Discord is not ready', () => {
    const startup = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    assert.ok(startup.indexOf('webServer.listen') < startup.indexOf('void connectBot();'));
    assert.match(startup, /Discord login failed; webhook receipts remain available, retrying/u);
    assert.match(compose, /fetch\('http:\/\/127\.0\.0\.1:3000\/health\/webhook'\)/u);
  });

  it('deploys the image and encryption key without an environment test-mode switch', () => {
    assert.match(workflow, /environment: production/u);
    assert.doesNotMatch(workflow + deploy + compose, /KOFI_TEST_MODE/u);
    assert.match(workflow, /printf '%s\\n' "\$KOFI_ENCRYPTION_KEY" \| ssh production \/opt\/renobot\/deploy\.sh "\$IMAGE"/u);
    assert.match(deploy, /"\$previous_image" "\$previous_key" > \.deploy\.env\s+chmod 600 \.deploy\.env/u);
  });

  it('supplies the GitHub Ko-fi secret privately and guards against losing encrypted settings', () => {
    assert.match(workflow, /KOFI_ENCRYPTION_KEY: \$\{\{ secrets\.KOFI_ENCRYPTION_KEY \}\}/u);
    assert.match(workflow, /if \[\[ -z "\$KOFI_ENCRYPTION_KEY" \]\]/u);
    assert.match(deploy, /\(\s+umask 077\s+printf 'RENOBOT_IMAGE=%s/u);
    assert.match(deploy, /chmod 600 \.deploy\.env\.next\s+\)/u);
    assert.match(deploy, /read -r kofi_key/u);
    assert.match(deploy, /"\$previous_key" != "\$kofi_key"/u);
    assert.match(deploy, /SELECT COUNT\(\*\) AS count FROM kofi_integration/u);
    assert.match(deploy, /KOFI_ENCRYPTION_KEY=%s\\n/u);
    assert.match(compose, /KOFI_ENCRYPTION_KEY: \$\{KOFI_ENCRYPTION_KEY:-\}/u);
    assert.doesNotMatch(workflow, /ssh production .*\$KOFI_ENCRYPTION_KEY/u);
  });
});
