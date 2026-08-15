import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encodeWurst, openWurstFile, sha256 } from '../packages/format/src/index.js';
import { invokePigLinkAction } from '../packages/headless/src/index.js';

const child = encodeWurst({
  manifest: {
    format: 'wurst/7', id: 'io.wrst.texture-packer', name: 'TexturePacker', version: '1.0.0', entry: 'index.html',
    application: { protection: 'public' }, capabilities: {},
    piglink: {
      format: 'wurst/piglink-1', headless: true, entry: '__wurst/piglink/entry.js',
      actions: {
        pack: { input: { type: 'object' }, output: { type: 'object' } }
      }, events: { progress: { payload: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } }
    }
  },
  files: [
    { path: 'index.html', data: Buffer.from('<h1>TexturePacker</h1>'), mime: 'text/html', scope: 'app' },
    { path: '__wurst/piglink/entry.js', data: Buffer.from(`PigLink.define({actions:{pack:({name})=>{wurst.piglink.emit('progress',{name:String(name||'atlas')});return {atlas:String(name||'atlas')+'.png',packed:true};}}})`), mime: 'text/javascript', scope: 'piglink' }
  ]
});

const parent = encodeWurst({
  manifest: {
    format: 'wurst/7', id: 'io.wrst.workspace', name: 'WurstWorkspace', version: '1.0.0', entry: 'index.html',
    application: { protection: 'public' }, capabilities: {},
    pigfs: { format: 'wurst/pigfs-policy-1', writable: true, realms: [{ id: 'workspace', mount: '/workspace' }] },
    piglet: {
      format: 'wurst/piglet-1',
      children: [{ id: 'texture-packer', entry: '__wurst/piglets/texture-packer.wurst', length: child.length, sha256: sha256(child) }]
    },
    piglink: {
      format: 'wurst/piglink-1', headless: true, entry: '__wurst/piglink/entry.js',
      actions: {
        build: { input: { type: 'object' }, output: { type: 'object' } },
        shortcut: { input: { type: 'object' }, output: { type: 'object' } }
      }, events: {}
    }
  },
  files: [
    { path: 'index.html', data: Buffer.from('<h1>Workspace</h1>'), mime: 'text/html', scope: 'app' },
    { path: '__wurst/piglets/texture-packer.wurst', data: child, mime: 'application/vnd.wrst.wurst', scope: 'piglet' },
    { path: '__wurst/piglink/entry.js', data: Buffer.from(`
PigLink.define({actions:{
  async build(input){
    await wurst.pigfs.write('/workspace/headless.txt',new TextEncoder().encode('built:'+input.name),{mime:'text/plain'});
    const tool=await wurst.piglet.connect('builtin:texture-packer');
    const running=await wurst.piglet.running();
    const descriptor=await tool.piglink.describe();
    let progress=null;
    const off=tool.piglink.on('progress',(payload)=>{progress=payload;});
    const packed=await tool.piglink.invoke('pack',{name:input.name});
    off();
    await tool.close();
    return {packed,progress,running:running.length,after:(await wurst.piglet.running()).length,child:descriptor.info.id};
  },
  async shortcut(input){
    return wurst.piglet.invoke('builtin:texture-packer','pack',{name:input.name});
  }
}});
`), mime: 'text/javascript', scope: 'piglink' }
  ]
});

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wurster-headless-piglet-'));
try {
  const file = path.join(tmp, 'WurstWorkspace.wurst');
  await fs.writeFile(file, parent);
  const built = await invokePigLinkAction(file, 'build', { name: 'sprites' });
  assert.deepEqual(built.result, {
    packed: { atlas: 'sprites.png', packed: true },
    progress: { name: 'sprites' },
    running: 1,
    after: 0,
    child: 'io.wrst.texture-packer'
  });
  const reopened = await openWurstFile(file);
  try {
    const durable = await reopened.pigFsReadRange('/workspace/headless.txt');
    assert.equal(durable?.data?.toString(), 'built:sprites', 'headless PigLink must mutate the same durable Wurst PigFS');
  } finally { await reopened.close(); }
  const shortcut = await invokePigLinkAction(file, 'shortcut', { name: 'icons' });
  assert.deepEqual(shortcut.result, { atlas: 'icons.png', packed: true });
  console.log('✓ Headless Wurst can use a Child Wurst as a PigLink subtool without creating a DOM view');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
