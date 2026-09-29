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

  it('extracts public files from the selected image before switching the public symlink', () => {
    assert.match(deploy, /docker cp "\$container:\/app\/src\/static\/\." "\$staging\/"/u);
    assert.match(deploy, /docker compose [^\n]*up -d --no-deps --wait app[\s\S]*mv -Tf \/opt\/renobot\/public\.next \/opt\/renobot\/public/u);
    assert.ok(deploy.indexOf('docker cp') < deploy.indexOf('up -d --no-deps --wait app'));
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
    assert.match(deploy, /--mount type=bind,src=\/opt\/renobot\/data,dst=\/data/u);
    assert.match(deploy, /stat -c '%u:%g:%a' data/u);
    assert.ok(deploy.indexOf('install -d -m 0700 data') < deploy.indexOf('prisma migrate deploy'));
  });

  it('passes only validated GitHub environment test mode into Compose and restores it on rollback', () => {
    assert.match(workflow, /environment: production/u);
    assert.match(workflow, /KOFI_TEST_MODE: \$\{\{ vars\.KOFI_TEST_MODE \}\}/u);
    assert.match(workflow, /mode=\$\{KOFI_TEST_MODE:-false\}/u);
    assert.match(workflow, /"\$mode" != true && "\$mode" != false/u);
    assert.match(workflow, /ssh production \/opt\/renobot\/deploy\.sh "\$IMAGE" "\$mode"/u);
    assert.match(deploy, /"\$\{2:-false\}" != true && "\$\{2:-false\}" != false/u);
    assert.match(compose, /KOFI_TEST_MODE: \$\{KOFI_TEST_MODE:-false\}/u);
    assert.match(deploy, /KOFI_TEST_MODE=%s\\n' "\$previous_image" "\$previous_test_mode"/u);
  });
});
