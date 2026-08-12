const fs = require('fs');
const path = require('path');
const pluginPath = path.resolve(__dirname, '..', 'web', 'flow_wrangler.js');
const rawSource = fs.readFileSync(pluginPath, 'utf8').replace(/^import\s+[^;]+;\s*/gm, '');
const casesDir = path.resolve(__dirname, 'solver_v3_workflows');

function expectedEdges(wf) {
  return new Set((wf.links || []).map(l => `${l[1]}:${l[2]}>${l[3]}:${l[4]}`));
}

function runWorkflow(wf) {
  let registeredExtension = null;
  let nextLinkId = 1;
  const graph = {
    links: {}, nodes: [], _nodes: [],
    getNodeById(id){ return this.nodes.find(n => String(n.id) === String(id)); },
    beforeChange(){}, afterChange(){}, setDirtyCanvas(){}
  };
  function makeNode(x) {
    const n = JSON.parse(JSON.stringify(x));
    n.size = n.size || [280, 160];
    n.inputs = (n.inputs || []).map(i => ({...i, link:null}));
    n.outputs = (n.outputs || []).map(o => ({...o, links:[]}));
    n.getConnectionPos = function(isInput, i, out) {
      out[0] = this.pos[0] + (isInput ? 0 : this.size[0]);
      out[1] = this.pos[1] + 35 + i * 20;
      return out;
    };
    n.disconnectInput = function(i) {
      const id = this.inputs[i]?.link;
      if (id == null) return;
      const l = graph.links[id];
      if (l) {
        const o = graph.getNodeById(l.origin_id);
        if (o?.outputs?.[l.origin_slot]) o.outputs[l.origin_slot].links = o.outputs[l.origin_slot].links.filter(x => x !== id);
        delete graph.links[id];
      }
      this.inputs[i].link = null;
    };
    n.connect = function(oi, target, ii) {
      if (typeof target !== 'object') target = graph.getNodeById(target);
      const o = this.outputs[oi], inp = target?.inputs?.[ii];
      if (!o || !inp || !LiteGraph.isValidConnection(o.type, inp.type)) return false;
      if (inp.link != null) target.disconnectInput(ii);
      const id = nextLinkId++;
      graph.links[id] = {id, origin_id:this.id, origin_slot:oi, target_id:target.id, target_slot:ii};
      o.links.push(id); inp.link = id;
      return graph.links[id];
    };
    graph.nodes.push(n); graph._nodes.push(n); return n;
  }
  for (const n of wf.nodes || []) makeNode(n);
  const selected = Object.fromEntries(graph.nodes.map(n => [n.id, n]));
  const app = {
    graph,
    canvas:{selected_nodes:selected,current_node:graph.nodes[0],setDirty(){}},
    extensionManager:{toast:{add(){}}},
    registerExtension(e){ registeredExtension = e; },
  };
  const LiteGraph = { isValidConnection(a,b){ return a===b || a==='*' || b==='*'; } };
  function LGraphCanvas(){} LGraphCanvas.prototype = {};
  const window={innerWidth:1920,innerHeight:1080}, document={}; function MouseEvent(){}; const performance={now:()=>0};
  new Function('app','LiteGraph','LGraphCanvas','window','document','MouseEvent','performance',rawSource)(app,LiteGraph,LGraphCanvas,window,document,MouseEvent,performance);
  registeredExtension.commands.find(c => c.id === 'flow-wrangler.smart-connect').function();
  return new Set(Object.values(graph.links).map(l => `${l.origin_id}:${l.origin_slot}>${l.target_id}:${l.target_slot}`));
}

const unc = fs.readdirSync(casesDir).filter(n => n.endsWith('_unconnected.json')).sort();
const results = [];
for (const name of unc) {
  const expectedName = name.replace('_unconnected.json', '_expected.json');
  const input = JSON.parse(fs.readFileSync(path.join(casesDir, name), 'utf8'));
  const expected = JSON.parse(fs.readFileSync(path.join(casesDir, expectedName), 'utf8'));
  const got = runWorkflow(input), want = expectedEdges(expected);
  const missing = [...want].filter(e => !got.has(e));
  const extra = [...got].filter(e => !want.has(e));
  if (missing.length || extra.length) {
    throw new Error(`${name}: missing=${JSON.stringify(missing.slice(0,20))} extra=${JSON.stringify(extra.slice(0,20))}`);
  }
  results.push({name, links:want.size});
}
console.log(JSON.stringify({passed:true, cases:results.length, results}));
