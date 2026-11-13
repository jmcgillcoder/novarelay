import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const read = p => fs.readFileSync(path.resolve('..',p),'utf8');

test('release metadata, program version and UI about text are consistent',()=>{
  const pkg=JSON.parse(read('native/package.json'));
  const release=JSON.parse(read('native/release.json'));
  assert.equal(pkg.version,release.version);
  assert.match(read('native/server.mjs'),new RegExp(`version:'${pkg.version.replaceAll('.','\\.')}'`));
  assert.match(read('native/public/index.html'),new RegExp(`v${pkg.version.replaceAll('.','\\.')}`));
  assert.match(read('README.md'),new RegExp(`v${pkg.version.replaceAll('.','\\.')}`));
});

test('standalone deployment configuration is self-contained and Docker socket is absent',()=>{
  const installer=read('install.sh');
  const compose=read('native/compose.yml');
  assert.match(installer,/\/opt\/novarelay/);
  assert.match(installer,/jmcgillcoder\/novarelay/);
  assert.match(compose,/name: novarelay/);
  assert.match(compose,/container_name: novarelay/);
  assert.match(installer,/novarelay-updater\.path/);
  assert.match(read('native/lib/updater.mjs'),/jmcgillcoder\/novarelay/);
  assert.match(read('native/public/index.html'),/NovaRelay（星桥）/);
  assert.match(read('native/public/index.html'),/<span class="text-brand">NR<\/span>/);
  assert.match(compose,/127\.0\.0\.1|network_mode: host/);
  assert.match(compose,/max-size/);
  assert.match(compose,/stop_grace_period/);
  assert.match(read('native/Dockerfile'),/PORT=8323/);
  assert.doesNotMatch(compose,/docker\.sock/);
});

test('new independent repository retains upstream MIT attribution and pinned source',()=>{
  const license=read('LICENSE'),notice=read('NOTICE.md'),docker=read('native/Dockerfile');
  assert.match(license,/MIT License/);
  assert.match(license,/chaos-cl/);
  assert.match(notice,/chaos-cl\/lingxi-gateway/);
  assert.match(docker,/df76aa618dfe8c3999e9ede7e76211eae36e701f/);
  assert.match(docker,/COPY --from=upstream \/src\/lingxi\/LICENSE/);
});

test('public repository documentation states unsupported agent capabilities',()=>{
  const readme=read('README.md'),codex=read('docs/CODEX.md'),claude=read('docs/CLAUDE_CODE.md');
  assert.match(readme,/不支持.*previous_response_id/);
  assert.match(codex,/apply_patch/);
  assert.match(claude,/signature_delta/);
  assert.match(readme,/不是运营商实际扣费/);
  assert.match(readme,/独立开发和维护/);
});
