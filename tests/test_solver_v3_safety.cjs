const fs = require('fs');
const path = require('path');
const pluginPath = path.resolve(__dirname, '..', 'web', 'flow_wrangler.js');
let source = fs.readFileSync(pluginPath, 'utf8').replace(/^import\s+\{\s*app\s*\}\s+from\s+[^;]+;\s*/m, '');
let registeredExtension = null, nextLinkId = 1;
const graph = { links:{}, nodes:[], getNodeById(id){return this.nodes.find(n=>String(n.id)===String(id))}, beforeChange(){}, afterChange(){}, setDirtyCanvas(){} };
function makeNode(id,type,title,x,y,inputs,outputs,widgets_values=[]) {
  const n={id,type,title,pos:[x,y],size:[280,150],properties:{'Node name for S&R':type},widgets_values,
    inputs:inputs.map((v)=>{const [name,t,shape]=v;const x={name,type:t,link:null};if(shape!=null)x.shape=shape;return x}),
    outputs:outputs.map(([name,t])=>({name,type:t,links:[]})),
    getConnectionPos(isInput,i,out){out[0]=this.pos[0]+(isInput?0:this.size[0]);out[1]=this.pos[1]+35+i*20;return out},
    disconnectInput(i){const id=this.inputs[i]?.link;if(id==null)return;const l=graph.links[id];if(l){const o=graph.getNodeById(l.origin_id);o.outputs[l.origin_slot].links=o.outputs[l.origin_slot].links.filter(x=>x!==id);delete graph.links[id]}this.inputs[i].link=null},
    connect(oi,t,ii){if(typeof t!=='object')t=graph.getNodeById(t);const o=this.outputs[oi],inp=t?.inputs?.[ii];if(!o||!inp||!LiteGraph.isValidConnection(o.type,inp.type))return false;if(inp.link!=null)t.disconnectInput(ii);const id=nextLinkId++;graph.links[id]={id,origin_id:this.id,origin_slot:oi,target_id:t.id,target_slot:ii};o.links.push(id);inp.link=id;return graph.links[id]}
  }; graph.nodes.push(n); return n;
}
function origin(target,i=0){const l=graph.links[target.inputs[i]?.link];return l?graph.getNodeById(l.origin_id):null}

// 1) Final sink title may mention Pose Control as pipeline config, but must still use final decode.
const poseRef = makeNode(1,'LoadImage','Krea2｜Pose Reference',50,50,[],[['IMAGE','IMG_A'],['MASK','MASK_A']]);
const pose = makeNode(2,'AIO_Preprocessor','Krea2｜DWPose Pose Extract',500,50,[['image','IMG_A']],[['IMAGE','IMG_A']],['DWPreprocessor',1024]);
const finalDecode = makeNode(3,'VAEDecode','Krea2｜Final Decode',1100,250,[],[['IMAGE','IMG_A']]);
const save = makeNode(4,'SaveImage','Save｜Krea2 Pose Control + LoRA',1500,70,[['images','IMG_A']],[]);
const controlPreview = makeNode(5,'PreviewImage','Preview｜Pose Control Map',1000,20,[['images','IMG_A']],[]);

// 2) Generic MODEL transformer must participate in the chain without a name whitelist.
const base = makeNode(10,'UNETLoader','Krea2｜Base',50,600,[],[['MODEL','MODEL']]);
const lora = makeNode(11,'LoraLoaderModelOnly','Krea2｜Character LoRA',420,600,[['model','MODEL']],[['MODEL','MODEL']]);
const customApply = makeNode(12,'ThirdPartyModelApply','Krea2 Control｜Custom Model Apply',800,600,[['model','MODEL']],[['MODEL','MODEL']]);
const sampler = makeNode(13,'KSampler','Krea2｜Sampler',1200,600,[['model','MODEL']],[]);

// 3) Optional mask must stay empty when target has no mask/inpaint intent.
const init = makeNode(20,'LoadImage','Anima｜Init Image',50,1050,[],[['IMAGE','IMG_B'],['MASK','MASK_B']]);
const lllite = makeNode(21,'AnimaLLLiteApply','Anima｜Pose LLLite',700,1050,[['image','IMG_B'],['mask','MASK_B',7]],[['MODEL','UNUSED_MODEL']]);

// 4) Decoder must consume generated sampler latent when earlier latents also exist.
const encoded = makeNode(30,'VAEEncode','Anima｜img2img Encode',50,1450,[],[['LATENT','LAT_C']]);
const sampled = makeNode(31,'KSampler','Anima｜Final Sampler',600,1450,[],[['LATENT','LAT_C']]);
const decode = makeNode(32,'VAEDecode','Anima｜Final Decode',1100,1450,[['samples','LAT_C']],[]);

// 5) Ambiguous generic images: do not guess when two sources are nearly tied.
const ambiguousA = makeNode(40,'LoadImage','Image A',100,1900,[],[['IMAGE','IMAGE']]);
const ambiguousB = makeNode(41,'LoadImage','Image B',110,1960,[],[['IMAGE','IMAGE']]);
const ambiguousTarget = makeNode(42,'ThirdPartyImageTransform','Image Transform',900,1930,[['image','IMAGE']],[]);

const app={graph,canvas:{selected_nodes:Object.fromEntries(graph.nodes.map(n=>[n.id,n])),current_node:poseRef,setDirty(){}},extensionManager:{toast:{add(){}}},registerExtension(e){registeredExtension=e}};
const LiteGraph={isValidConnection(a,b){return a===b||a==='*'||b==='*'}}; function LGraphCanvas(){} LGraphCanvas.prototype={};
const window={innerWidth:1920,innerHeight:1080},document={}; function MouseEvent(){}; const performance={now:()=>0};
new Function('app','LiteGraph','LGraphCanvas','window','document','MouseEvent','performance',source)(app,LiteGraph,LGraphCanvas,window,document,MouseEvent,performance);
registeredExtension.commands.find(c=>c.id==='flow-wrangler.smart-connect').function();

if(origin(pose)!==poseRef) throw new Error('Pose reference did not feed DWPose');
if(origin(controlPreview)!==pose) throw new Error('Pose control preview did not use DWPose');
if(origin(save)!==finalDecode) throw new Error('Final sink was hijacked by control image despite a final decode');
if(origin(lora)!==base || origin(customApply)!==lora || origin(sampler)!==customApply) throw new Error('Generic MODEL transformer chain was not preserved');
if(origin(lllite,1)!==null) throw new Error('Optional mask was auto-filled without mask/inpaint intent');
if(origin(decode)!==sampled) throw new Error('Decoder did not prefer generated sampler latent');
if(origin(ambiguousTarget)!==null) throw new Error('Ambiguous generic IMAGE input should abstain instead of guessing');
console.log(JSON.stringify({passed:true, finalSink:true, genericModelTransformer:true, optionalMaskAbstention:true, generatedLatent:true, ambiguityAbstention:true}));
