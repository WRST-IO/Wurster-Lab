import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(new URL('.', import.meta.url).pathname, 'demo');
const runtime = path.resolve(new URL('.', import.meta.url).pathname, 'dist');
const port = Number(process.env.PORT || 8787);
const server = http.createServer((req,res)=>{let file;if(req.url==='/wurster.min.js')file=path.join(runtime,'wurster.min.js');else if(req.url==='/wurster-sw.js')file=path.join(runtime,'wurster-sw.js');else file=path.join(root,req.url==='/'?'index.html':req.url.replace(/^\//,''));if(!file.startsWith(root)&&!file.startsWith(runtime)){res.writeHead(403);return res.end();}fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);return res.end('not found');}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':'application/octet-stream');res.end(data);});});
server.listen(port,()=>console.log(`Wurster Web demo: http://localhost:${port}`));
