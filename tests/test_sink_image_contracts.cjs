const fs = require('fs');
const path = require('path');
const pluginPath = path.resolve(__dirname, '..', 'web', 'flow_wrangler.js');
let source = fs.readFileSync(pluginPath, 'utf8').replace(/^import\s+\{\s*app\s*\}\s+from\s+[^;]+;\s*/m, '');
let registeredExtension = null, nextLinkId = 1;
const graph = { links:{}, nodes:[], getNodeById(id){return this.nodes.find(n=>String(n.id)===String(id))}, beforeChange(){}, afterChange(){}, setDirtyCanvas(){} };
function makeNode(id,type,title,x,y,inputs,outputs,widgets_values=[]) {
  const n={id,type,title,pos:[x,y],size:[280,150],properties:{'Node name for S&R':type},widgets_values,
    inputs:inputs.map(([name,t])=>({name,type:t,link:null})), outputs:outputs.map(([name,t])=>({name,type:t,links:[]})),
    getConnectionPos(isInput,i,out){out[0]=this.pos[0]+(isInput?0:this.size[0]);out[1]=this.pos[1]+35+i*20;return out},
    disconnectInput(i){const id=this.inputs[i].link;if(id==null)return;const l=graph.links[id];if(l){const o=graph.getNodeById(l.origin_id);o.outputs[l.origin_slot].links=o.outputs[l.origin_slot].links.filter(x=>x!==id);delete graph.links[id]}this.inputs[i].link=null},
    connect(oi,t,ii){if(typeof t!=='object')t=graph.getNodeById(t);const o=this.outputs[oi],inp=t?.inputs?.[ii];if(!o||!inp||!LiteGraph.isValidConnection(o.type,inp.type))return false;if(inp.link!=null)t.disconnectInput(ii);const id=nextLinkId++;graph.links[id]={id,origin_id:this.id,origin_slot:oi,target_id:t.id,target_slot:ii};o.links.push(id);inp.link=id;return graph.links[id]}
  }; graph.nodes.push(n); return n;
}
const raw = makeNode(1,'LoadImage','Anima｜姿态参考图',100,300,[],[['IMAGE','IMAGE_CONTRACT']]);
const pose = makeNode(2,'AIO_Preprocessor','Anima｜DWPose 姿态提取',600,300,[['image','IMAGE_CONTRACT']],[['IMAGE','IMAGE_CONTRACT']],['DWPreprocessor',1024]);
const final = makeNode(3,'VAEDecode','Anima｜最终解码',1200,0,[],[['IMAGE','IMAGE_CONTRACT']]);
const posePreview = makeNode(4,'PreviewImage','预览｜Anima Pose 控制图',1200,300,[['images','IMAGE_CONTRACT']],[]);
const finalSave = makeNode(5,'SaveImage','保存｜Anima Pose + 官方 LoRA',1700,0,[['images','IMAGE_CONTRACT']],[]);
const finalPreview = makeNode(6,'PreviewImage','预览｜Anima 最终图',1700,170,[['images','IMAGE_CONTRACT']],[]);
const poseSave = makeNode(7,'SaveImage','Save Pose Control Map',1700,360,[['images','IMAGE_CONTRACT']],[]);
const app={graph,canvas:{selected_nodes:Object.fromEntries(graph.nodes.map(n=>[n.id,n])),current_node:raw,setDirty(){}},extensionManager:{toast:{add(){}}},registerExtension(e){registeredExtension=e}};
const LiteGraph={isValidConnection(a,b){return a===b||a==='*'||b==='*'}};function LGraphCanvas(){}LGraphCanvas.prototype={};const window={innerWidth:1920,innerHeight:1080},document={};function MouseEvent(){};const performance={now:()=>0};
new Function('app','LiteGraph','LGraphCanvas','window','document','MouseEvent','performance',source)(app,LiteGraph,LGraphCanvas,window,document,MouseEvent,performance);
registeredExtension.commands.find(c=>c.id==='flow-wrangler.smart-connect').function();
function origin(target){const l=graph.links[target.inputs[0].link];return l?graph.getNodeById(l.origin_id):null}
if(origin(pose)!==raw) throw new Error('Raw pose reference did not feed DWPose');
if(origin(posePreview)!==pose) throw new Error('Pose control preview did not use DWPose');
if(origin(poseSave)!==pose) throw new Error('Explicit Pose control save did not use DWPose');
if(origin(finalSave)!==final) throw new Error('Final SaveImage was hijacked by Pose control signal');
if(origin(finalPreview)!==final) throw new Error('Final PreviewImage was hijacked by Pose control signal');
console.log(JSON.stringify({passed:true,finalSinkContract:true,explicitControlSinkContract:true}));
