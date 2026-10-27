"use strict";
module.exports = validate10;
module.exports.default = validate10;
const schema11 = {"$schema":"http://json-schema.org/draft-07/schema#","title":"OMT document v1","type":"object","additionalProperties":false,"required":["schema_version","kind","id","issued_at","issuer","subject","payload"],"properties":{"schema_version":{"const":1},"kind":{"type":"string","enum":["review_request","review_result","status_report","task_request","completion_report","interruption_report"]},"id":{"$ref":"#/definitions/text"},"issued_at":{"$ref":"#/definitions/timestamp"},"in_reply_to":{"$ref":"#/definitions/text"},"issuer":{"type":"object","additionalProperties":false,"required":["session_id"],"properties":{"session_id":{"$ref":"#/definitions/text"}}},"subject":{"type":"object","additionalProperties":false,"required":["worktree_id"],"properties":{"worktree_id":{"$ref":"#/definitions/text"},"commit":{"$ref":"#/definitions/commit"},"implementation_session_id":{"$ref":"#/definitions/text"}}},"payload":{"type":"object"}},"allOf":[{"if":{"properties":{"kind":{"const":"review_request"}}},"then":{"properties":{"payload":{"$ref":"#/definitions/reviewRequest"}}}},{"if":{"properties":{"kind":{"const":"review_result"}}},"then":{"required":["in_reply_to"],"properties":{"in_reply_to":{"$ref":"#/definitions/text"},"payload":{"$ref":"#/definitions/reviewResult"}}}},{"if":{"properties":{"kind":{"const":"status_report"}}},"then":{"properties":{"payload":{"$ref":"#/definitions/statusReport"}}}},{"if":{"properties":{"kind":{"const":"task_request"}}},"then":{"properties":{"payload":{"$ref":"#/definitions/taskRequest"}}}},{"if":{"properties":{"kind":{"const":"completion_report"}}},"then":{"properties":{"payload":{"$ref":"#/definitions/completionReport"},"in_reply_to":{"$ref":"#/definitions/text"}},"required":["in_reply_to"]}},{"if":{"properties":{"kind":{"const":"interruption_report"}}},"then":{"properties":{"payload":{"$ref":"#/definitions/interruptionReport"},"in_reply_to":{"$ref":"#/definitions/text"}},"required":["in_reply_to"]}}],"definitions":{"text":{"type":"string","minLength":1,"pattern":"\\S"},"texts":{"type":"array","items":{"$ref":"#/definitions/text"}},"commit":{"type":"string","pattern":"^(?:[a-f0-9]{40}|[a-f0-9]{64})$"},"timestamp":{"type":"string","format":"date-time"},"evidence":{"type":"object","additionalProperties":false,"required":["source","locator"],"properties":{"source":{"type":"string","enum":["file","git","orca","ci","user"]},"locator":{"$ref":"#/definitions/text"},"excerpt":{"$ref":"#/definitions/text"}}},"reviewRequest":{"type":"object","additionalProperties":false,"required":["purpose","question","facts","options","constraints","acceptance_criteria","evidence"],"properties":{"purpose":{"type":"string","enum":["advisor","lawyer","auditor"]},"question":{"$ref":"#/definitions/text"},"facts":{"$ref":"#/definitions/texts"},"options":{"$ref":"#/definitions/texts"},"constraints":{"$ref":"#/definitions/texts"},"acceptance_criteria":{"type":"array","minItems":1,"items":{"$ref":"#/definitions/text"}},"evidence":{"type":"array","items":{"$ref":"#/definitions/evidence"}}}},"reviewResult":{"type":"object","additionalProperties":false,"required":["purpose","conclusion","summary","recommendation","counterarguments","independent","findings","uncertainties","evidence"],"properties":{"purpose":{"type":"string","enum":["advisor","lawyer","auditor"]},"conclusion":{"type":"string","enum":["recommended","changes_requested","no_findings","inconclusive"]},"summary":{"$ref":"#/definitions/text"},"recommendation":{"$ref":"#/definitions/text"},"counterarguments":{"$ref":"#/definitions/texts"},"independent":{"type":"boolean"},"findings":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["severity","description","evidence"],"properties":{"severity":{"type":"string","enum":["high","medium","low"]},"description":{"$ref":"#/definitions/text"},"evidence":{"type":"array","minItems":1,"items":{"$ref":"#/definitions/evidence"}}}}},"uncertainties":{"$ref":"#/definitions/texts"},"evidence":{"type":"array","items":{"$ref":"#/definitions/evidence"}}}},"ci":{"type":"object","additionalProperties":false,"required":["name","build_id","source_commit","target_branch","status","observed_at"],"properties":{"name":{"$ref":"#/definitions/text"},"build_id":{"anyOf":[{"$ref":"#/definitions/text"},{"type":"null"}]},"source_commit":{"anyOf":[{"$ref":"#/definitions/commit"},{"type":"null"}]},"target_branch":{"anyOf":[{"$ref":"#/definitions/text"},{"type":"null"}]},"status":{"type":"string","enum":["unregistered","queued","running","passed","failed","cancelled","skipped","unknown"]},"observed_at":{"$ref":"#/definitions/timestamp"}}},"statusReport":{"type":"object","additionalProperties":false,"required":["summary","observation","execution","worktree","git","ci","delivery","cleanup","remaining","uncertainties","evidence"],"properties":{"summary":{"$ref":"#/definitions/text"},"observation":{"type":"string","enum":["complete","partial","failed"]},"execution":{"type":"string","enum":["unknown","running","succeeded","failed","stopped"]},"worktree":{"type":"object","additionalProperties":false,"required":["id","instance_id","owner_session_id"],"properties":{"id":{"$ref":"#/definitions/text"},"instance_id":{"$ref":"#/definitions/text"},"owner_session_id":{"anyOf":[{"$ref":"#/definitions/text"},{"type":"null"}]}}},"git":{"anyOf":[{"type":"object","additionalProperties":false,"required":["head","dirty"],"properties":{"head":{"$ref":"#/definitions/commit"},"dirty":{"type":"boolean"}}},{"type":"null"}]},"ci":{"type":"array","items":{"$ref":"#/definitions/ci"}},"delivery":{"$ref":"#/definitions/delivery"},"cleanup":{"$ref":"#/definitions/cleanup"},"remaining":{"$ref":"#/definitions/texts"},"uncertainties":{"$ref":"#/definitions/texts"},"evidence":{"type":"array","items":{"$ref":"#/definitions/evidence"}}}},"delivery":{"type":"object","additionalProperties":false,"required":["state","reference"],"properties":{"state":{"type":"string","enum":["not_requested","pending","delivered","unknown"]},"reference":{"anyOf":[{"$ref":"#/definitions/text"},{"type":"null"}]}}},"cleanup":{"type":"object","additionalProperties":false,"required":["state","remaining"],"properties":{"state":{"type":"string","enum":["not_requested","pending","completed","preserved","unknown"]},"remaining":{"$ref":"#/definitions/texts"}}},"taskRequest":{"type":"object","additionalProperties":false,"required":["goal","scope","acceptance_criteria","constraints","required_checks","delivery","cleanup_required","evidence"],"properties":{"goal":{"$ref":"#/definitions/text"},"scope":{"type":"array","items":{"$ref":"#/definitions/text"},"minItems":1},"acceptance_criteria":{"type":"array","items":{"$ref":"#/definitions/text"},"minItems":1},"constraints":{"$ref":"#/definitions/texts"},"required_checks":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["name","command"],"properties":{"name":{"$ref":"#/definitions/text"},"command":{"$ref":"#/definitions/text"}}},"minItems":0},"delivery":{"type":"object","additionalProperties":false,"required":["mode","target","authorization"],"properties":{"mode":{"type":"string","enum":["none","commit","pr","merge","artifact"]},"target":{"anyOf":[{"$ref":"#/definitions/text"},{"type":"null"}]},"authorization":{"anyOf":[{"$ref":"#/definitions/text"},{"type":"null"}]}}},"cleanup_required":{"type":"boolean"},"evidence":{"type":"array","items":{"$ref":"#/definitions/evidence"},"minItems":0}}},"completionReport":{"type":"object","additionalProperties":false,"required":["summary","outcome","acceptance_results","checks","ci","delivery","cleanup","remaining","uncertainties","evidence"],"properties":{"summary":{"$ref":"#/definitions/text"},"outcome":{"type":"string","enum":["completed","incomplete"]},"acceptance_results":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["criterion","result","evidence"],"properties":{"criterion":{"$ref":"#/definitions/text"},"result":{"type":"string","enum":["met","unmet","unknown"]},"evidence":{"type":"array","items":{"$ref":"#/definitions/evidence"},"minItems":0}}},"minItems":1},"checks":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["name","required","status","command","evidence"],"properties":{"name":{"$ref":"#/definitions/text"},"required":{"type":"boolean"},"status":{"type":"string","enum":["passed","failed","unknown","skipped","unregistered"]},"command":{"$ref":"#/definitions/text"},"evidence":{"type":"array","items":{"$ref":"#/definitions/evidence"},"minItems":0}}},"minItems":0},"ci":{"type":"array","items":{"$ref":"#/definitions/ci"},"minItems":0},"delivery":{"$ref":"#/definitions/delivery"},"cleanup":{"$ref":"#/definitions/cleanup"},"remaining":{"$ref":"#/definitions/texts"},"uncertainties":{"$ref":"#/definitions/texts"},"evidence":{"type":"array","items":{"$ref":"#/definitions/evidence"},"minItems":0}}},"interruptionReport":{"type":"object","additionalProperties":false,"required":["summary","reason","undelivered_changes","sessions","delivery","cleanup","resume_steps","uncertainties","evidence"],"properties":{"summary":{"$ref":"#/definitions/text"},"reason":{"$ref":"#/definitions/text"},"undelivered_changes":{"$ref":"#/definitions/texts"},"sessions":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["session_id","worktree_id","instance_id","liveness","action","stop_authorization"],"properties":{"session_id":{"$ref":"#/definitions/text"},"worktree_id":{"$ref":"#/definitions/text"},"instance_id":{"$ref":"#/definitions/text"},"liveness":{"type":"string","enum":["running","exited","unknown"]},"action":{"type":"string","enum":["preserved","stop_requested","stopped"]},"stop_authorization":{"anyOf":[{"$ref":"#/definitions/text"},{"type":"null"}]}}},"minItems":0},"delivery":{"$ref":"#/definitions/delivery"},"cleanup":{"$ref":"#/definitions/cleanup"},"resume_steps":{"type":"array","items":{"$ref":"#/definitions/text"},"minItems":1},"uncertainties":{"$ref":"#/definitions/texts"},"evidence":{"type":"array","items":{"$ref":"#/definitions/evidence"},"minItems":0}}}}};
const schema13 = {"type":"string","minLength":1,"pattern":"\\S"};
const schema36 = {"type":"string","format":"date-time"};
const schema30 = {"type":"string","pattern":"^(?:[a-f0-9]{40}|[a-f0-9]{64})$"};
const schema12 = {"type":"object","additionalProperties":false,"required":["purpose","question","facts","options","constraints","acceptance_criteria","evidence"],"properties":{"purpose":{"type":"string","enum":["advisor","lawyer","auditor"]},"question":{"$ref":"#/definitions/text"},"facts":{"$ref":"#/definitions/texts"},"options":{"$ref":"#/definitions/texts"},"constraints":{"$ref":"#/definitions/texts"},"acceptance_criteria":{"type":"array","minItems":1,"items":{"$ref":"#/definitions/text"}},"evidence":{"type":"array","items":{"$ref":"#/definitions/evidence"}}}};
const func2 = require("./ucs2length.cjs").default;
const pattern0 = new RegExp("\\S", "u");
const schema14 = {"type":"array","items":{"$ref":"#/definitions/text"}};

function validate12(data, {instancePath="", parentData, parentDataProperty, rootData=data}={}){
let vErrors = null;
let errors = 0;
if(Array.isArray(data)){
const len0 = data.length;
for(let i0=0; i0<len0; i0++){
let data0 = data[i0];
if(typeof data0 === "string"){
if(func2(data0) < 1){
const err0 = {instancePath:instancePath+"/" + i0,schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
if(!pattern0.test(data0)){
const err1 = {instancePath:instancePath+"/" + i0,schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
}
}
else {
const err2 = {instancePath:instancePath+"/" + i0,schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
}
}
else {
const err3 = {instancePath,schemaPath:"#/type",keyword:"type",params:{type: "array"},message:"must be array"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
validate12.errors = vErrors;
return errors === 0;
}

const schema17 = {"type":"object","additionalProperties":false,"required":["source","locator"],"properties":{"source":{"type":"string","enum":["file","git","orca","ci","user"]},"locator":{"$ref":"#/definitions/text"},"excerpt":{"$ref":"#/definitions/text"}}};

function validate16(data, {instancePath="", parentData, parentDataProperty, rootData=data}={}){
let vErrors = null;
let errors = 0;
if(data && typeof data == "object" && !Array.isArray(data)){
if(data.source === undefined){
const err0 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "source"},message:"must have required property '"+"source"+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
if(data.locator === undefined){
const err1 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "locator"},message:"must have required property '"+"locator"+"'"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
}
for(const key0 in data){
if(!(((key0 === "source") || (key0 === "locator")) || (key0 === "excerpt"))){
const err2 = {instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
}
if(data.source !== undefined){
let data0 = data.source;
if(typeof data0 !== "string"){
const err3 = {instancePath:instancePath+"/source",schemaPath:"#/properties/source/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
if(!(((((data0 === "file") || (data0 === "git")) || (data0 === "orca")) || (data0 === "ci")) || (data0 === "user"))){
const err4 = {instancePath:instancePath+"/source",schemaPath:"#/properties/source/enum",keyword:"enum",params:{allowedValues: schema17.properties.source.enum},message:"must be equal to one of the allowed values"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
}
if(data.locator !== undefined){
let data1 = data.locator;
if(typeof data1 === "string"){
if(func2(data1) < 1){
const err5 = {instancePath:instancePath+"/locator",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
if(!pattern0.test(data1)){
const err6 = {instancePath:instancePath+"/locator",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
}
}
else {
const err7 = {instancePath:instancePath+"/locator",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
}
if(data.excerpt !== undefined){
let data2 = data.excerpt;
if(typeof data2 === "string"){
if(func2(data2) < 1){
const err8 = {instancePath:instancePath+"/excerpt",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err8];
}
else {
vErrors.push(err8);
}
errors++;
}
if(!pattern0.test(data2)){
const err9 = {instancePath:instancePath+"/excerpt",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
}
}
else {
const err10 = {instancePath:instancePath+"/excerpt",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
}
}
else {
const err11 = {instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
}
validate16.errors = vErrors;
return errors === 0;
}


function validate11(data, {instancePath="", parentData, parentDataProperty, rootData=data}={}){
let vErrors = null;
let errors = 0;
if(data && typeof data == "object" && !Array.isArray(data)){
if(data.purpose === undefined){
const err0 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "purpose"},message:"must have required property '"+"purpose"+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
if(data.question === undefined){
const err1 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "question"},message:"must have required property '"+"question"+"'"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
}
if(data.facts === undefined){
const err2 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "facts"},message:"must have required property '"+"facts"+"'"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
if(data.options === undefined){
const err3 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "options"},message:"must have required property '"+"options"+"'"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
if(data.constraints === undefined){
const err4 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "constraints"},message:"must have required property '"+"constraints"+"'"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
if(data.acceptance_criteria === undefined){
const err5 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "acceptance_criteria"},message:"must have required property '"+"acceptance_criteria"+"'"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
if(data.evidence === undefined){
const err6 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "evidence"},message:"must have required property '"+"evidence"+"'"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
}
for(const key0 in data){
if(!(((((((key0 === "purpose") || (key0 === "question")) || (key0 === "facts")) || (key0 === "options")) || (key0 === "constraints")) || (key0 === "acceptance_criteria")) || (key0 === "evidence"))){
const err7 = {instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
}
if(data.purpose !== undefined){
let data0 = data.purpose;
if(typeof data0 !== "string"){
const err8 = {instancePath:instancePath+"/purpose",schemaPath:"#/properties/purpose/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err8];
}
else {
vErrors.push(err8);
}
errors++;
}
if(!(((data0 === "advisor") || (data0 === "lawyer")) || (data0 === "auditor"))){
const err9 = {instancePath:instancePath+"/purpose",schemaPath:"#/properties/purpose/enum",keyword:"enum",params:{allowedValues: schema12.properties.purpose.enum},message:"must be equal to one of the allowed values"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
}
}
if(data.question !== undefined){
let data1 = data.question;
if(typeof data1 === "string"){
if(func2(data1) < 1){
const err10 = {instancePath:instancePath+"/question",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
if(!pattern0.test(data1)){
const err11 = {instancePath:instancePath+"/question",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
}
}
else {
const err12 = {instancePath:instancePath+"/question",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err12];
}
else {
vErrors.push(err12);
}
errors++;
}
}
if(data.facts !== undefined){
if(!(validate12(data.facts, {instancePath:instancePath+"/facts",parentData:data,parentDataProperty:"facts",rootData}))){
vErrors = vErrors === null ? validate12.errors : vErrors.concat(validate12.errors);
errors = vErrors.length;
}
}
if(data.options !== undefined){
if(!(validate12(data.options, {instancePath:instancePath+"/options",parentData:data,parentDataProperty:"options",rootData}))){
vErrors = vErrors === null ? validate12.errors : vErrors.concat(validate12.errors);
errors = vErrors.length;
}
}
if(data.constraints !== undefined){
if(!(validate12(data.constraints, {instancePath:instancePath+"/constraints",parentData:data,parentDataProperty:"constraints",rootData}))){
vErrors = vErrors === null ? validate12.errors : vErrors.concat(validate12.errors);
errors = vErrors.length;
}
}
if(data.acceptance_criteria !== undefined){
let data5 = data.acceptance_criteria;
if(Array.isArray(data5)){
if(data5.length < 1){
const err13 = {instancePath:instancePath+"/acceptance_criteria",schemaPath:"#/properties/acceptance_criteria/minItems",keyword:"minItems",params:{limit: 1},message:"must NOT have fewer than 1 items"};
if(vErrors === null){
vErrors = [err13];
}
else {
vErrors.push(err13);
}
errors++;
}
const len0 = data5.length;
for(let i0=0; i0<len0; i0++){
let data6 = data5[i0];
if(typeof data6 === "string"){
if(func2(data6) < 1){
const err14 = {instancePath:instancePath+"/acceptance_criteria/" + i0,schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err14];
}
else {
vErrors.push(err14);
}
errors++;
}
if(!pattern0.test(data6)){
const err15 = {instancePath:instancePath+"/acceptance_criteria/" + i0,schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err15];
}
else {
vErrors.push(err15);
}
errors++;
}
}
else {
const err16 = {instancePath:instancePath+"/acceptance_criteria/" + i0,schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err16];
}
else {
vErrors.push(err16);
}
errors++;
}
}
}
else {
const err17 = {instancePath:instancePath+"/acceptance_criteria",schemaPath:"#/properties/acceptance_criteria/type",keyword:"type",params:{type: "array"},message:"must be array"};
if(vErrors === null){
vErrors = [err17];
}
else {
vErrors.push(err17);
}
errors++;
}
}
if(data.evidence !== undefined){
let data7 = data.evidence;
if(Array.isArray(data7)){
const len1 = data7.length;
for(let i1=0; i1<len1; i1++){
if(!(validate16(data7[i1], {instancePath:instancePath+"/evidence/" + i1,parentData:data7,parentDataProperty:i1,rootData}))){
vErrors = vErrors === null ? validate16.errors : vErrors.concat(validate16.errors);
errors = vErrors.length;
}
}
}
else {
const err18 = {instancePath:instancePath+"/evidence",schemaPath:"#/properties/evidence/type",keyword:"type",params:{type: "array"},message:"must be array"};
if(vErrors === null){
vErrors = [err18];
}
else {
vErrors.push(err18);
}
errors++;
}
}
}
else {
const err19 = {instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err19];
}
else {
vErrors.push(err19);
}
errors++;
}
validate11.errors = vErrors;
return errors === 0;
}

const schema21 = {"type":"object","additionalProperties":false,"required":["purpose","conclusion","summary","recommendation","counterarguments","independent","findings","uncertainties","evidence"],"properties":{"purpose":{"type":"string","enum":["advisor","lawyer","auditor"]},"conclusion":{"type":"string","enum":["recommended","changes_requested","no_findings","inconclusive"]},"summary":{"$ref":"#/definitions/text"},"recommendation":{"$ref":"#/definitions/text"},"counterarguments":{"$ref":"#/definitions/texts"},"independent":{"type":"boolean"},"findings":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["severity","description","evidence"],"properties":{"severity":{"type":"string","enum":["high","medium","low"]},"description":{"$ref":"#/definitions/text"},"evidence":{"type":"array","minItems":1,"items":{"$ref":"#/definitions/evidence"}}}}},"uncertainties":{"$ref":"#/definitions/texts"},"evidence":{"type":"array","items":{"$ref":"#/definitions/evidence"}}}};
const func8 = Object.prototype.hasOwnProperty;

function validate19(data, {instancePath="", parentData, parentDataProperty, rootData=data}={}){
let vErrors = null;
let errors = 0;
if(data && typeof data == "object" && !Array.isArray(data)){
if(data.purpose === undefined){
const err0 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "purpose"},message:"must have required property '"+"purpose"+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
if(data.conclusion === undefined){
const err1 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "conclusion"},message:"must have required property '"+"conclusion"+"'"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
}
if(data.summary === undefined){
const err2 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "summary"},message:"must have required property '"+"summary"+"'"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
if(data.recommendation === undefined){
const err3 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "recommendation"},message:"must have required property '"+"recommendation"+"'"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
if(data.counterarguments === undefined){
const err4 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "counterarguments"},message:"must have required property '"+"counterarguments"+"'"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
if(data.independent === undefined){
const err5 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "independent"},message:"must have required property '"+"independent"+"'"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
if(data.findings === undefined){
const err6 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "findings"},message:"must have required property '"+"findings"+"'"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
}
if(data.uncertainties === undefined){
const err7 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "uncertainties"},message:"must have required property '"+"uncertainties"+"'"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
if(data.evidence === undefined){
const err8 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "evidence"},message:"must have required property '"+"evidence"+"'"};
if(vErrors === null){
vErrors = [err8];
}
else {
vErrors.push(err8);
}
errors++;
}
for(const key0 in data){
if(!(func8.call(schema21.properties, key0))){
const err9 = {instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
}
}
if(data.purpose !== undefined){
let data0 = data.purpose;
if(typeof data0 !== "string"){
const err10 = {instancePath:instancePath+"/purpose",schemaPath:"#/properties/purpose/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
if(!(((data0 === "advisor") || (data0 === "lawyer")) || (data0 === "auditor"))){
const err11 = {instancePath:instancePath+"/purpose",schemaPath:"#/properties/purpose/enum",keyword:"enum",params:{allowedValues: schema21.properties.purpose.enum},message:"must be equal to one of the allowed values"};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
}
}
if(data.conclusion !== undefined){
let data1 = data.conclusion;
if(typeof data1 !== "string"){
const err12 = {instancePath:instancePath+"/conclusion",schemaPath:"#/properties/conclusion/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err12];
}
else {
vErrors.push(err12);
}
errors++;
}
if(!((((data1 === "recommended") || (data1 === "changes_requested")) || (data1 === "no_findings")) || (data1 === "inconclusive"))){
const err13 = {instancePath:instancePath+"/conclusion",schemaPath:"#/properties/conclusion/enum",keyword:"enum",params:{allowedValues: schema21.properties.conclusion.enum},message:"must be equal to one of the allowed values"};
if(vErrors === null){
vErrors = [err13];
}
else {
vErrors.push(err13);
}
errors++;
}
}
if(data.summary !== undefined){
let data2 = data.summary;
if(typeof data2 === "string"){
if(func2(data2) < 1){
const err14 = {instancePath:instancePath+"/summary",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err14];
}
else {
vErrors.push(err14);
}
errors++;
}
if(!pattern0.test(data2)){
const err15 = {instancePath:instancePath+"/summary",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err15];
}
else {
vErrors.push(err15);
}
errors++;
}
}
else {
const err16 = {instancePath:instancePath+"/summary",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err16];
}
else {
vErrors.push(err16);
}
errors++;
}
}
if(data.recommendation !== undefined){
let data3 = data.recommendation;
if(typeof data3 === "string"){
if(func2(data3) < 1){
const err17 = {instancePath:instancePath+"/recommendation",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err17];
}
else {
vErrors.push(err17);
}
errors++;
}
if(!pattern0.test(data3)){
const err18 = {instancePath:instancePath+"/recommendation",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err18];
}
else {
vErrors.push(err18);
}
errors++;
}
}
else {
const err19 = {instancePath:instancePath+"/recommendation",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err19];
}
else {
vErrors.push(err19);
}
errors++;
}
}
if(data.counterarguments !== undefined){
if(!(validate12(data.counterarguments, {instancePath:instancePath+"/counterarguments",parentData:data,parentDataProperty:"counterarguments",rootData}))){
vErrors = vErrors === null ? validate12.errors : vErrors.concat(validate12.errors);
errors = vErrors.length;
}
}
if(data.independent !== undefined){
if(typeof data.independent !== "boolean"){
const err20 = {instancePath:instancePath+"/independent",schemaPath:"#/properties/independent/type",keyword:"type",params:{type: "boolean"},message:"must be boolean"};
if(vErrors === null){
vErrors = [err20];
}
else {
vErrors.push(err20);
}
errors++;
}
}
if(data.findings !== undefined){
let data6 = data.findings;
if(Array.isArray(data6)){
const len0 = data6.length;
for(let i0=0; i0<len0; i0++){
let data7 = data6[i0];
if(data7 && typeof data7 == "object" && !Array.isArray(data7)){
if(data7.severity === undefined){
const err21 = {instancePath:instancePath+"/findings/" + i0,schemaPath:"#/properties/findings/items/required",keyword:"required",params:{missingProperty: "severity"},message:"must have required property '"+"severity"+"'"};
if(vErrors === null){
vErrors = [err21];
}
else {
vErrors.push(err21);
}
errors++;
}
if(data7.description === undefined){
const err22 = {instancePath:instancePath+"/findings/" + i0,schemaPath:"#/properties/findings/items/required",keyword:"required",params:{missingProperty: "description"},message:"must have required property '"+"description"+"'"};
if(vErrors === null){
vErrors = [err22];
}
else {
vErrors.push(err22);
}
errors++;
}
if(data7.evidence === undefined){
const err23 = {instancePath:instancePath+"/findings/" + i0,schemaPath:"#/properties/findings/items/required",keyword:"required",params:{missingProperty: "evidence"},message:"must have required property '"+"evidence"+"'"};
if(vErrors === null){
vErrors = [err23];
}
else {
vErrors.push(err23);
}
errors++;
}
for(const key1 in data7){
if(!(((key1 === "severity") || (key1 === "description")) || (key1 === "evidence"))){
const err24 = {instancePath:instancePath+"/findings/" + i0,schemaPath:"#/properties/findings/items/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err24];
}
else {
vErrors.push(err24);
}
errors++;
}
}
if(data7.severity !== undefined){
let data8 = data7.severity;
if(typeof data8 !== "string"){
const err25 = {instancePath:instancePath+"/findings/" + i0+"/severity",schemaPath:"#/properties/findings/items/properties/severity/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err25];
}
else {
vErrors.push(err25);
}
errors++;
}
if(!(((data8 === "high") || (data8 === "medium")) || (data8 === "low"))){
const err26 = {instancePath:instancePath+"/findings/" + i0+"/severity",schemaPath:"#/properties/findings/items/properties/severity/enum",keyword:"enum",params:{allowedValues: schema21.properties.findings.items.properties.severity.enum},message:"must be equal to one of the allowed values"};
if(vErrors === null){
vErrors = [err26];
}
else {
vErrors.push(err26);
}
errors++;
}
}
if(data7.description !== undefined){
let data9 = data7.description;
if(typeof data9 === "string"){
if(func2(data9) < 1){
const err27 = {instancePath:instancePath+"/findings/" + i0+"/description",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err27];
}
else {
vErrors.push(err27);
}
errors++;
}
if(!pattern0.test(data9)){
const err28 = {instancePath:instancePath+"/findings/" + i0+"/description",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err28];
}
else {
vErrors.push(err28);
}
errors++;
}
}
else {
const err29 = {instancePath:instancePath+"/findings/" + i0+"/description",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err29];
}
else {
vErrors.push(err29);
}
errors++;
}
}
if(data7.evidence !== undefined){
let data10 = data7.evidence;
if(Array.isArray(data10)){
if(data10.length < 1){
const err30 = {instancePath:instancePath+"/findings/" + i0+"/evidence",schemaPath:"#/properties/findings/items/properties/evidence/minItems",keyword:"minItems",params:{limit: 1},message:"must NOT have fewer than 1 items"};
if(vErrors === null){
vErrors = [err30];
}
else {
vErrors.push(err30);
}
errors++;
}
const len1 = data10.length;
for(let i1=0; i1<len1; i1++){
if(!(validate16(data10[i1], {instancePath:instancePath+"/findings/" + i0+"/evidence/" + i1,parentData:data10,parentDataProperty:i1,rootData}))){
vErrors = vErrors === null ? validate16.errors : vErrors.concat(validate16.errors);
errors = vErrors.length;
}
}
}
else {
const err31 = {instancePath:instancePath+"/findings/" + i0+"/evidence",schemaPath:"#/properties/findings/items/properties/evidence/type",keyword:"type",params:{type: "array"},message:"must be array"};
if(vErrors === null){
vErrors = [err31];
}
else {
vErrors.push(err31);
}
errors++;
}
}
}
else {
const err32 = {instancePath:instancePath+"/findings/" + i0,schemaPath:"#/properties/findings/items/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err32];
}
else {
vErrors.push(err32);
}
errors++;
}
}
}
else {
const err33 = {instancePath:instancePath+"/findings",schemaPath:"#/properties/findings/type",keyword:"type",params:{type: "array"},message:"must be array"};
if(vErrors === null){
vErrors = [err33];
}
else {
vErrors.push(err33);
}
errors++;
}
}
if(data.uncertainties !== undefined){
if(!(validate12(data.uncertainties, {instancePath:instancePath+"/uncertainties",parentData:data,parentDataProperty:"uncertainties",rootData}))){
vErrors = vErrors === null ? validate12.errors : vErrors.concat(validate12.errors);
errors = vErrors.length;
}
}
if(data.evidence !== undefined){
let data13 = data.evidence;
if(Array.isArray(data13)){
const len2 = data13.length;
for(let i2=0; i2<len2; i2++){
if(!(validate16(data13[i2], {instancePath:instancePath+"/evidence/" + i2,parentData:data13,parentDataProperty:i2,rootData}))){
vErrors = vErrors === null ? validate16.errors : vErrors.concat(validate16.errors);
errors = vErrors.length;
}
}
}
else {
const err34 = {instancePath:instancePath+"/evidence",schemaPath:"#/properties/evidence/type",keyword:"type",params:{type: "array"},message:"must be array"};
if(vErrors === null){
vErrors = [err34];
}
else {
vErrors.push(err34);
}
errors++;
}
}
}
else {
const err35 = {instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err35];
}
else {
vErrors.push(err35);
}
errors++;
}
validate19.errors = vErrors;
return errors === 0;
}

const schema25 = {"type":"object","additionalProperties":false,"required":["summary","observation","execution","worktree","git","ci","delivery","cleanup","remaining","uncertainties","evidence"],"properties":{"summary":{"$ref":"#/definitions/text"},"observation":{"type":"string","enum":["complete","partial","failed"]},"execution":{"type":"string","enum":["unknown","running","succeeded","failed","stopped"]},"worktree":{"type":"object","additionalProperties":false,"required":["id","instance_id","owner_session_id"],"properties":{"id":{"$ref":"#/definitions/text"},"instance_id":{"$ref":"#/definitions/text"},"owner_session_id":{"anyOf":[{"$ref":"#/definitions/text"},{"type":"null"}]}}},"git":{"anyOf":[{"type":"object","additionalProperties":false,"required":["head","dirty"],"properties":{"head":{"$ref":"#/definitions/commit"},"dirty":{"type":"boolean"}}},{"type":"null"}]},"ci":{"type":"array","items":{"$ref":"#/definitions/ci"}},"delivery":{"$ref":"#/definitions/delivery"},"cleanup":{"$ref":"#/definitions/cleanup"},"remaining":{"$ref":"#/definitions/texts"},"uncertainties":{"$ref":"#/definitions/texts"},"evidence":{"type":"array","items":{"$ref":"#/definitions/evidence"}}}};
const pattern13 = new RegExp("^(?:[a-f0-9]{40}|[a-f0-9]{64})$", "u");
const schema31 = {"type":"object","additionalProperties":false,"required":["name","build_id","source_commit","target_branch","status","observed_at"],"properties":{"name":{"$ref":"#/definitions/text"},"build_id":{"anyOf":[{"$ref":"#/definitions/text"},{"type":"null"}]},"source_commit":{"anyOf":[{"$ref":"#/definitions/commit"},{"type":"null"}]},"target_branch":{"anyOf":[{"$ref":"#/definitions/text"},{"type":"null"}]},"status":{"type":"string","enum":["unregistered","queued","running","passed","failed","cancelled","skipped","unknown"]},"observed_at":{"$ref":"#/definitions/timestamp"}}};
const formats0 = require("./formats.cjs").fullFormats["date-time"];

function validate26(data, {instancePath="", parentData, parentDataProperty, rootData=data}={}){
let vErrors = null;
let errors = 0;
if(data && typeof data == "object" && !Array.isArray(data)){
if(data.name === undefined){
const err0 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "name"},message:"must have required property '"+"name"+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
if(data.build_id === undefined){
const err1 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "build_id"},message:"must have required property '"+"build_id"+"'"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
}
if(data.source_commit === undefined){
const err2 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "source_commit"},message:"must have required property '"+"source_commit"+"'"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
if(data.target_branch === undefined){
const err3 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "target_branch"},message:"must have required property '"+"target_branch"+"'"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
if(data.status === undefined){
const err4 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "status"},message:"must have required property '"+"status"+"'"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
if(data.observed_at === undefined){
const err5 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "observed_at"},message:"must have required property '"+"observed_at"+"'"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
for(const key0 in data){
if(!((((((key0 === "name") || (key0 === "build_id")) || (key0 === "source_commit")) || (key0 === "target_branch")) || (key0 === "status")) || (key0 === "observed_at"))){
const err6 = {instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
}
}
if(data.name !== undefined){
let data0 = data.name;
if(typeof data0 === "string"){
if(func2(data0) < 1){
const err7 = {instancePath:instancePath+"/name",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
if(!pattern0.test(data0)){
const err8 = {instancePath:instancePath+"/name",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err8];
}
else {
vErrors.push(err8);
}
errors++;
}
}
else {
const err9 = {instancePath:instancePath+"/name",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
}
}
if(data.build_id !== undefined){
let data1 = data.build_id;
const _errs6 = errors;
let valid2 = false;
const _errs7 = errors;
if(typeof data1 === "string"){
if(func2(data1) < 1){
const err10 = {instancePath:instancePath+"/build_id",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
if(!pattern0.test(data1)){
const err11 = {instancePath:instancePath+"/build_id",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
}
}
else {
const err12 = {instancePath:instancePath+"/build_id",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err12];
}
else {
vErrors.push(err12);
}
errors++;
}
var _valid0 = _errs7 === errors;
valid2 = valid2 || _valid0;
if(!valid2){
const _errs10 = errors;
if(data1 !== null){
const err13 = {instancePath:instancePath+"/build_id",schemaPath:"#/properties/build_id/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err13];
}
else {
vErrors.push(err13);
}
errors++;
}
var _valid0 = _errs10 === errors;
valid2 = valid2 || _valid0;
}
if(!valid2){
const err14 = {instancePath:instancePath+"/build_id",schemaPath:"#/properties/build_id/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err14];
}
else {
vErrors.push(err14);
}
errors++;
}
else {
errors = _errs6;
if(vErrors !== null){
if(_errs6){
vErrors.length = _errs6;
}
else {
vErrors = null;
}
}
}
}
if(data.source_commit !== undefined){
let data2 = data.source_commit;
const _errs13 = errors;
let valid4 = false;
const _errs14 = errors;
if(typeof data2 === "string"){
if(!pattern13.test(data2)){
const err15 = {instancePath:instancePath+"/source_commit",schemaPath:"#/definitions/commit/pattern",keyword:"pattern",params:{pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$"},message:"must match pattern \""+"^(?:[a-f0-9]{40}|[a-f0-9]{64})$"+"\""};
if(vErrors === null){
vErrors = [err15];
}
else {
vErrors.push(err15);
}
errors++;
}
}
else {
const err16 = {instancePath:instancePath+"/source_commit",schemaPath:"#/definitions/commit/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err16];
}
else {
vErrors.push(err16);
}
errors++;
}
var _valid1 = _errs14 === errors;
valid4 = valid4 || _valid1;
if(!valid4){
const _errs17 = errors;
if(data2 !== null){
const err17 = {instancePath:instancePath+"/source_commit",schemaPath:"#/properties/source_commit/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err17];
}
else {
vErrors.push(err17);
}
errors++;
}
var _valid1 = _errs17 === errors;
valid4 = valid4 || _valid1;
}
if(!valid4){
const err18 = {instancePath:instancePath+"/source_commit",schemaPath:"#/properties/source_commit/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err18];
}
else {
vErrors.push(err18);
}
errors++;
}
else {
errors = _errs13;
if(vErrors !== null){
if(_errs13){
vErrors.length = _errs13;
}
else {
vErrors = null;
}
}
}
}
if(data.target_branch !== undefined){
let data3 = data.target_branch;
const _errs20 = errors;
let valid6 = false;
const _errs21 = errors;
if(typeof data3 === "string"){
if(func2(data3) < 1){
const err19 = {instancePath:instancePath+"/target_branch",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err19];
}
else {
vErrors.push(err19);
}
errors++;
}
if(!pattern0.test(data3)){
const err20 = {instancePath:instancePath+"/target_branch",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err20];
}
else {
vErrors.push(err20);
}
errors++;
}
}
else {
const err21 = {instancePath:instancePath+"/target_branch",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err21];
}
else {
vErrors.push(err21);
}
errors++;
}
var _valid2 = _errs21 === errors;
valid6 = valid6 || _valid2;
if(!valid6){
const _errs24 = errors;
if(data3 !== null){
const err22 = {instancePath:instancePath+"/target_branch",schemaPath:"#/properties/target_branch/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err22];
}
else {
vErrors.push(err22);
}
errors++;
}
var _valid2 = _errs24 === errors;
valid6 = valid6 || _valid2;
}
if(!valid6){
const err23 = {instancePath:instancePath+"/target_branch",schemaPath:"#/properties/target_branch/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err23];
}
else {
vErrors.push(err23);
}
errors++;
}
else {
errors = _errs20;
if(vErrors !== null){
if(_errs20){
vErrors.length = _errs20;
}
else {
vErrors = null;
}
}
}
}
if(data.status !== undefined){
let data4 = data.status;
if(typeof data4 !== "string"){
const err24 = {instancePath:instancePath+"/status",schemaPath:"#/properties/status/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err24];
}
else {
vErrors.push(err24);
}
errors++;
}
if(!((((((((data4 === "unregistered") || (data4 === "queued")) || (data4 === "running")) || (data4 === "passed")) || (data4 === "failed")) || (data4 === "cancelled")) || (data4 === "skipped")) || (data4 === "unknown"))){
const err25 = {instancePath:instancePath+"/status",schemaPath:"#/properties/status/enum",keyword:"enum",params:{allowedValues: schema31.properties.status.enum},message:"must be equal to one of the allowed values"};
if(vErrors === null){
vErrors = [err25];
}
else {
vErrors.push(err25);
}
errors++;
}
}
if(data.observed_at !== undefined){
let data5 = data.observed_at;
if(typeof data5 === "string"){
if(!(formats0.validate(data5))){
const err26 = {instancePath:instancePath+"/observed_at",schemaPath:"#/definitions/timestamp/format",keyword:"format",params:{format: "date-time"},message:"must match format \""+"date-time"+"\""};
if(vErrors === null){
vErrors = [err26];
}
else {
vErrors.push(err26);
}
errors++;
}
}
else {
const err27 = {instancePath:instancePath+"/observed_at",schemaPath:"#/definitions/timestamp/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err27];
}
else {
vErrors.push(err27);
}
errors++;
}
}
}
else {
const err28 = {instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err28];
}
else {
vErrors.push(err28);
}
errors++;
}
validate26.errors = vErrors;
return errors === 0;
}

const schema37 = {"type":"object","additionalProperties":false,"required":["state","reference"],"properties":{"state":{"type":"string","enum":["not_requested","pending","delivered","unknown"]},"reference":{"anyOf":[{"$ref":"#/definitions/text"},{"type":"null"}]}}};

function validate28(data, {instancePath="", parentData, parentDataProperty, rootData=data}={}){
let vErrors = null;
let errors = 0;
if(data && typeof data == "object" && !Array.isArray(data)){
if(data.state === undefined){
const err0 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "state"},message:"must have required property '"+"state"+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
if(data.reference === undefined){
const err1 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "reference"},message:"must have required property '"+"reference"+"'"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
}
for(const key0 in data){
if(!((key0 === "state") || (key0 === "reference"))){
const err2 = {instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
}
if(data.state !== undefined){
let data0 = data.state;
if(typeof data0 !== "string"){
const err3 = {instancePath:instancePath+"/state",schemaPath:"#/properties/state/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
if(!((((data0 === "not_requested") || (data0 === "pending")) || (data0 === "delivered")) || (data0 === "unknown"))){
const err4 = {instancePath:instancePath+"/state",schemaPath:"#/properties/state/enum",keyword:"enum",params:{allowedValues: schema37.properties.state.enum},message:"must be equal to one of the allowed values"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
}
if(data.reference !== undefined){
let data1 = data.reference;
const _errs5 = errors;
let valid1 = false;
const _errs6 = errors;
if(typeof data1 === "string"){
if(func2(data1) < 1){
const err5 = {instancePath:instancePath+"/reference",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
if(!pattern0.test(data1)){
const err6 = {instancePath:instancePath+"/reference",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
}
}
else {
const err7 = {instancePath:instancePath+"/reference",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
var _valid0 = _errs6 === errors;
valid1 = valid1 || _valid0;
if(!valid1){
const _errs9 = errors;
if(data1 !== null){
const err8 = {instancePath:instancePath+"/reference",schemaPath:"#/properties/reference/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err8];
}
else {
vErrors.push(err8);
}
errors++;
}
var _valid0 = _errs9 === errors;
valid1 = valid1 || _valid0;
}
if(!valid1){
const err9 = {instancePath:instancePath+"/reference",schemaPath:"#/properties/reference/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
}
else {
errors = _errs5;
if(vErrors !== null){
if(_errs5){
vErrors.length = _errs5;
}
else {
vErrors = null;
}
}
}
}
}
else {
const err10 = {instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
validate28.errors = vErrors;
return errors === 0;
}

const schema39 = {"type":"object","additionalProperties":false,"required":["state","remaining"],"properties":{"state":{"type":"string","enum":["not_requested","pending","completed","preserved","unknown"]},"remaining":{"$ref":"#/definitions/texts"}}};

function validate30(data, {instancePath="", parentData, parentDataProperty, rootData=data}={}){
let vErrors = null;
let errors = 0;
if(data && typeof data == "object" && !Array.isArray(data)){
if(data.state === undefined){
const err0 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "state"},message:"must have required property '"+"state"+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
if(data.remaining === undefined){
const err1 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "remaining"},message:"must have required property '"+"remaining"+"'"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
}
for(const key0 in data){
if(!((key0 === "state") || (key0 === "remaining"))){
const err2 = {instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
}
if(data.state !== undefined){
let data0 = data.state;
if(typeof data0 !== "string"){
const err3 = {instancePath:instancePath+"/state",schemaPath:"#/properties/state/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
if(!(((((data0 === "not_requested") || (data0 === "pending")) || (data0 === "completed")) || (data0 === "preserved")) || (data0 === "unknown"))){
const err4 = {instancePath:instancePath+"/state",schemaPath:"#/properties/state/enum",keyword:"enum",params:{allowedValues: schema39.properties.state.enum},message:"must be equal to one of the allowed values"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
}
if(data.remaining !== undefined){
if(!(validate12(data.remaining, {instancePath:instancePath+"/remaining",parentData:data,parentDataProperty:"remaining",rootData}))){
vErrors = vErrors === null ? validate12.errors : vErrors.concat(validate12.errors);
errors = vErrors.length;
}
}
}
else {
const err5 = {instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
validate30.errors = vErrors;
return errors === 0;
}


function validate25(data, {instancePath="", parentData, parentDataProperty, rootData=data}={}){
let vErrors = null;
let errors = 0;
if(data && typeof data == "object" && !Array.isArray(data)){
if(data.summary === undefined){
const err0 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "summary"},message:"must have required property '"+"summary"+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
if(data.observation === undefined){
const err1 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "observation"},message:"must have required property '"+"observation"+"'"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
}
if(data.execution === undefined){
const err2 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "execution"},message:"must have required property '"+"execution"+"'"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
if(data.worktree === undefined){
const err3 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "worktree"},message:"must have required property '"+"worktree"+"'"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
if(data.git === undefined){
const err4 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "git"},message:"must have required property '"+"git"+"'"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
if(data.ci === undefined){
const err5 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "ci"},message:"must have required property '"+"ci"+"'"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
if(data.delivery === undefined){
const err6 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "delivery"},message:"must have required property '"+"delivery"+"'"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
}
if(data.cleanup === undefined){
const err7 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "cleanup"},message:"must have required property '"+"cleanup"+"'"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
if(data.remaining === undefined){
const err8 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "remaining"},message:"must have required property '"+"remaining"+"'"};
if(vErrors === null){
vErrors = [err8];
}
else {
vErrors.push(err8);
}
errors++;
}
if(data.uncertainties === undefined){
const err9 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "uncertainties"},message:"must have required property '"+"uncertainties"+"'"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
}
if(data.evidence === undefined){
const err10 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "evidence"},message:"must have required property '"+"evidence"+"'"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
for(const key0 in data){
if(!(func8.call(schema25.properties, key0))){
const err11 = {instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
}
}
if(data.summary !== undefined){
let data0 = data.summary;
if(typeof data0 === "string"){
if(func2(data0) < 1){
const err12 = {instancePath:instancePath+"/summary",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err12];
}
else {
vErrors.push(err12);
}
errors++;
}
if(!pattern0.test(data0)){
const err13 = {instancePath:instancePath+"/summary",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err13];
}
else {
vErrors.push(err13);
}
errors++;
}
}
else {
const err14 = {instancePath:instancePath+"/summary",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err14];
}
else {
vErrors.push(err14);
}
errors++;
}
}
if(data.observation !== undefined){
let data1 = data.observation;
if(typeof data1 !== "string"){
const err15 = {instancePath:instancePath+"/observation",schemaPath:"#/properties/observation/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err15];
}
else {
vErrors.push(err15);
}
errors++;
}
if(!(((data1 === "complete") || (data1 === "partial")) || (data1 === "failed"))){
const err16 = {instancePath:instancePath+"/observation",schemaPath:"#/properties/observation/enum",keyword:"enum",params:{allowedValues: schema25.properties.observation.enum},message:"must be equal to one of the allowed values"};
if(vErrors === null){
vErrors = [err16];
}
else {
vErrors.push(err16);
}
errors++;
}
}
if(data.execution !== undefined){
let data2 = data.execution;
if(typeof data2 !== "string"){
const err17 = {instancePath:instancePath+"/execution",schemaPath:"#/properties/execution/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err17];
}
else {
vErrors.push(err17);
}
errors++;
}
if(!(((((data2 === "unknown") || (data2 === "running")) || (data2 === "succeeded")) || (data2 === "failed")) || (data2 === "stopped"))){
const err18 = {instancePath:instancePath+"/execution",schemaPath:"#/properties/execution/enum",keyword:"enum",params:{allowedValues: schema25.properties.execution.enum},message:"must be equal to one of the allowed values"};
if(vErrors === null){
vErrors = [err18];
}
else {
vErrors.push(err18);
}
errors++;
}
}
if(data.worktree !== undefined){
let data3 = data.worktree;
if(data3 && typeof data3 == "object" && !Array.isArray(data3)){
if(data3.id === undefined){
const err19 = {instancePath:instancePath+"/worktree",schemaPath:"#/properties/worktree/required",keyword:"required",params:{missingProperty: "id"},message:"must have required property '"+"id"+"'"};
if(vErrors === null){
vErrors = [err19];
}
else {
vErrors.push(err19);
}
errors++;
}
if(data3.instance_id === undefined){
const err20 = {instancePath:instancePath+"/worktree",schemaPath:"#/properties/worktree/required",keyword:"required",params:{missingProperty: "instance_id"},message:"must have required property '"+"instance_id"+"'"};
if(vErrors === null){
vErrors = [err20];
}
else {
vErrors.push(err20);
}
errors++;
}
if(data3.owner_session_id === undefined){
const err21 = {instancePath:instancePath+"/worktree",schemaPath:"#/properties/worktree/required",keyword:"required",params:{missingProperty: "owner_session_id"},message:"must have required property '"+"owner_session_id"+"'"};
if(vErrors === null){
vErrors = [err21];
}
else {
vErrors.push(err21);
}
errors++;
}
for(const key1 in data3){
if(!(((key1 === "id") || (key1 === "instance_id")) || (key1 === "owner_session_id"))){
const err22 = {instancePath:instancePath+"/worktree",schemaPath:"#/properties/worktree/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err22];
}
else {
vErrors.push(err22);
}
errors++;
}
}
if(data3.id !== undefined){
let data4 = data3.id;
if(typeof data4 === "string"){
if(func2(data4) < 1){
const err23 = {instancePath:instancePath+"/worktree/id",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err23];
}
else {
vErrors.push(err23);
}
errors++;
}
if(!pattern0.test(data4)){
const err24 = {instancePath:instancePath+"/worktree/id",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err24];
}
else {
vErrors.push(err24);
}
errors++;
}
}
else {
const err25 = {instancePath:instancePath+"/worktree/id",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err25];
}
else {
vErrors.push(err25);
}
errors++;
}
}
if(data3.instance_id !== undefined){
let data5 = data3.instance_id;
if(typeof data5 === "string"){
if(func2(data5) < 1){
const err26 = {instancePath:instancePath+"/worktree/instance_id",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err26];
}
else {
vErrors.push(err26);
}
errors++;
}
if(!pattern0.test(data5)){
const err27 = {instancePath:instancePath+"/worktree/instance_id",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err27];
}
else {
vErrors.push(err27);
}
errors++;
}
}
else {
const err28 = {instancePath:instancePath+"/worktree/instance_id",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err28];
}
else {
vErrors.push(err28);
}
errors++;
}
}
if(data3.owner_session_id !== undefined){
let data6 = data3.owner_session_id;
const _errs19 = errors;
let valid5 = false;
const _errs20 = errors;
if(typeof data6 === "string"){
if(func2(data6) < 1){
const err29 = {instancePath:instancePath+"/worktree/owner_session_id",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err29];
}
else {
vErrors.push(err29);
}
errors++;
}
if(!pattern0.test(data6)){
const err30 = {instancePath:instancePath+"/worktree/owner_session_id",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err30];
}
else {
vErrors.push(err30);
}
errors++;
}
}
else {
const err31 = {instancePath:instancePath+"/worktree/owner_session_id",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err31];
}
else {
vErrors.push(err31);
}
errors++;
}
var _valid0 = _errs20 === errors;
valid5 = valid5 || _valid0;
if(!valid5){
const _errs23 = errors;
if(data6 !== null){
const err32 = {instancePath:instancePath+"/worktree/owner_session_id",schemaPath:"#/properties/worktree/properties/owner_session_id/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err32];
}
else {
vErrors.push(err32);
}
errors++;
}
var _valid0 = _errs23 === errors;
valid5 = valid5 || _valid0;
}
if(!valid5){
const err33 = {instancePath:instancePath+"/worktree/owner_session_id",schemaPath:"#/properties/worktree/properties/owner_session_id/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err33];
}
else {
vErrors.push(err33);
}
errors++;
}
else {
errors = _errs19;
if(vErrors !== null){
if(_errs19){
vErrors.length = _errs19;
}
else {
vErrors = null;
}
}
}
}
}
else {
const err34 = {instancePath:instancePath+"/worktree",schemaPath:"#/properties/worktree/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err34];
}
else {
vErrors.push(err34);
}
errors++;
}
}
if(data.git !== undefined){
let data7 = data.git;
const _errs26 = errors;
let valid7 = false;
const _errs27 = errors;
if(data7 && typeof data7 == "object" && !Array.isArray(data7)){
if(data7.head === undefined){
const err35 = {instancePath:instancePath+"/git",schemaPath:"#/properties/git/anyOf/0/required",keyword:"required",params:{missingProperty: "head"},message:"must have required property '"+"head"+"'"};
if(vErrors === null){
vErrors = [err35];
}
else {
vErrors.push(err35);
}
errors++;
}
if(data7.dirty === undefined){
const err36 = {instancePath:instancePath+"/git",schemaPath:"#/properties/git/anyOf/0/required",keyword:"required",params:{missingProperty: "dirty"},message:"must have required property '"+"dirty"+"'"};
if(vErrors === null){
vErrors = [err36];
}
else {
vErrors.push(err36);
}
errors++;
}
for(const key2 in data7){
if(!((key2 === "head") || (key2 === "dirty"))){
const err37 = {instancePath:instancePath+"/git",schemaPath:"#/properties/git/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err37];
}
else {
vErrors.push(err37);
}
errors++;
}
}
if(data7.head !== undefined){
let data8 = data7.head;
if(typeof data8 === "string"){
if(!pattern13.test(data8)){
const err38 = {instancePath:instancePath+"/git/head",schemaPath:"#/definitions/commit/pattern",keyword:"pattern",params:{pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$"},message:"must match pattern \""+"^(?:[a-f0-9]{40}|[a-f0-9]{64})$"+"\""};
if(vErrors === null){
vErrors = [err38];
}
else {
vErrors.push(err38);
}
errors++;
}
}
else {
const err39 = {instancePath:instancePath+"/git/head",schemaPath:"#/definitions/commit/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err39];
}
else {
vErrors.push(err39);
}
errors++;
}
}
if(data7.dirty !== undefined){
if(typeof data7.dirty !== "boolean"){
const err40 = {instancePath:instancePath+"/git/dirty",schemaPath:"#/properties/git/anyOf/0/properties/dirty/type",keyword:"type",params:{type: "boolean"},message:"must be boolean"};
if(vErrors === null){
vErrors = [err40];
}
else {
vErrors.push(err40);
}
errors++;
}
}
}
else {
const err41 = {instancePath:instancePath+"/git",schemaPath:"#/properties/git/anyOf/0/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err41];
}
else {
vErrors.push(err41);
}
errors++;
}
var _valid1 = _errs27 === errors;
valid7 = valid7 || _valid1;
if(!valid7){
const _errs35 = errors;
if(data7 !== null){
const err42 = {instancePath:instancePath+"/git",schemaPath:"#/properties/git/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err42];
}
else {
vErrors.push(err42);
}
errors++;
}
var _valid1 = _errs35 === errors;
valid7 = valid7 || _valid1;
}
if(!valid7){
const err43 = {instancePath:instancePath+"/git",schemaPath:"#/properties/git/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err43];
}
else {
vErrors.push(err43);
}
errors++;
}
else {
errors = _errs26;
if(vErrors !== null){
if(_errs26){
vErrors.length = _errs26;
}
else {
vErrors = null;
}
}
}
}
if(data.ci !== undefined){
let data10 = data.ci;
if(Array.isArray(data10)){
const len0 = data10.length;
for(let i0=0; i0<len0; i0++){
if(!(validate26(data10[i0], {instancePath:instancePath+"/ci/" + i0,parentData:data10,parentDataProperty:i0,rootData}))){
vErrors = vErrors === null ? validate26.errors : vErrors.concat(validate26.errors);
errors = vErrors.length;
}
}
}
else {
const err44 = {instancePath:instancePath+"/ci",schemaPath:"#/properties/ci/type",keyword:"type",params:{type: "array"},message:"must be array"};
if(vErrors === null){
vErrors = [err44];
}
else {
vErrors.push(err44);
}
errors++;
}
}
if(data.delivery !== undefined){
if(!(validate28(data.delivery, {instancePath:instancePath+"/delivery",parentData:data,parentDataProperty:"delivery",rootData}))){
vErrors = vErrors === null ? validate28.errors : vErrors.concat(validate28.errors);
errors = vErrors.length;
}
}
if(data.cleanup !== undefined){
if(!(validate30(data.cleanup, {instancePath:instancePath+"/cleanup",parentData:data,parentDataProperty:"cleanup",rootData}))){
vErrors = vErrors === null ? validate30.errors : vErrors.concat(validate30.errors);
errors = vErrors.length;
}
}
if(data.remaining !== undefined){
if(!(validate12(data.remaining, {instancePath:instancePath+"/remaining",parentData:data,parentDataProperty:"remaining",rootData}))){
vErrors = vErrors === null ? validate12.errors : vErrors.concat(validate12.errors);
errors = vErrors.length;
}
}
if(data.uncertainties !== undefined){
if(!(validate12(data.uncertainties, {instancePath:instancePath+"/uncertainties",parentData:data,parentDataProperty:"uncertainties",rootData}))){
vErrors = vErrors === null ? validate12.errors : vErrors.concat(validate12.errors);
errors = vErrors.length;
}
}
if(data.evidence !== undefined){
let data16 = data.evidence;
if(Array.isArray(data16)){
const len1 = data16.length;
for(let i1=0; i1<len1; i1++){
if(!(validate16(data16[i1], {instancePath:instancePath+"/evidence/" + i1,parentData:data16,parentDataProperty:i1,rootData}))){
vErrors = vErrors === null ? validate16.errors : vErrors.concat(validate16.errors);
errors = vErrors.length;
}
}
}
else {
const err45 = {instancePath:instancePath+"/evidence",schemaPath:"#/properties/evidence/type",keyword:"type",params:{type: "array"},message:"must be array"};
if(vErrors === null){
vErrors = [err45];
}
else {
vErrors.push(err45);
}
errors++;
}
}
}
else {
const err46 = {instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err46];
}
else {
vErrors.push(err46);
}
errors++;
}
validate25.errors = vErrors;
return errors === 0;
}

const schema40 = {"type":"object","additionalProperties":false,"required":["goal","scope","acceptance_criteria","constraints","required_checks","delivery","cleanup_required","evidence"],"properties":{"goal":{"$ref":"#/definitions/text"},"scope":{"type":"array","items":{"$ref":"#/definitions/text"},"minItems":1},"acceptance_criteria":{"type":"array","items":{"$ref":"#/definitions/text"},"minItems":1},"constraints":{"$ref":"#/definitions/texts"},"required_checks":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["name","command"],"properties":{"name":{"$ref":"#/definitions/text"},"command":{"$ref":"#/definitions/text"}}},"minItems":0},"delivery":{"type":"object","additionalProperties":false,"required":["mode","target","authorization"],"properties":{"mode":{"type":"string","enum":["none","commit","pr","merge","artifact"]},"target":{"anyOf":[{"$ref":"#/definitions/text"},{"type":"null"}]},"authorization":{"anyOf":[{"$ref":"#/definitions/text"},{"type":"null"}]}}},"cleanup_required":{"type":"boolean"},"evidence":{"type":"array","items":{"$ref":"#/definitions/evidence"},"minItems":0}}};

function validate37(data, {instancePath="", parentData, parentDataProperty, rootData=data}={}){
let vErrors = null;
let errors = 0;
if(data && typeof data == "object" && !Array.isArray(data)){
if(data.goal === undefined){
const err0 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "goal"},message:"must have required property '"+"goal"+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
if(data.scope === undefined){
const err1 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "scope"},message:"must have required property '"+"scope"+"'"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
}
if(data.acceptance_criteria === undefined){
const err2 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "acceptance_criteria"},message:"must have required property '"+"acceptance_criteria"+"'"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
if(data.constraints === undefined){
const err3 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "constraints"},message:"must have required property '"+"constraints"+"'"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
if(data.required_checks === undefined){
const err4 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "required_checks"},message:"must have required property '"+"required_checks"+"'"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
if(data.delivery === undefined){
const err5 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "delivery"},message:"must have required property '"+"delivery"+"'"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
if(data.cleanup_required === undefined){
const err6 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "cleanup_required"},message:"must have required property '"+"cleanup_required"+"'"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
}
if(data.evidence === undefined){
const err7 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "evidence"},message:"must have required property '"+"evidence"+"'"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
for(const key0 in data){
if(!((((((((key0 === "goal") || (key0 === "scope")) || (key0 === "acceptance_criteria")) || (key0 === "constraints")) || (key0 === "required_checks")) || (key0 === "delivery")) || (key0 === "cleanup_required")) || (key0 === "evidence"))){
const err8 = {instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err8];
}
else {
vErrors.push(err8);
}
errors++;
}
}
if(data.goal !== undefined){
let data0 = data.goal;
if(typeof data0 === "string"){
if(func2(data0) < 1){
const err9 = {instancePath:instancePath+"/goal",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
}
if(!pattern0.test(data0)){
const err10 = {instancePath:instancePath+"/goal",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
}
else {
const err11 = {instancePath:instancePath+"/goal",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
}
}
if(data.scope !== undefined){
let data1 = data.scope;
if(Array.isArray(data1)){
if(data1.length < 1){
const err12 = {instancePath:instancePath+"/scope",schemaPath:"#/properties/scope/minItems",keyword:"minItems",params:{limit: 1},message:"must NOT have fewer than 1 items"};
if(vErrors === null){
vErrors = [err12];
}
else {
vErrors.push(err12);
}
errors++;
}
const len0 = data1.length;
for(let i0=0; i0<len0; i0++){
let data2 = data1[i0];
if(typeof data2 === "string"){
if(func2(data2) < 1){
const err13 = {instancePath:instancePath+"/scope/" + i0,schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err13];
}
else {
vErrors.push(err13);
}
errors++;
}
if(!pattern0.test(data2)){
const err14 = {instancePath:instancePath+"/scope/" + i0,schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err14];
}
else {
vErrors.push(err14);
}
errors++;
}
}
else {
const err15 = {instancePath:instancePath+"/scope/" + i0,schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err15];
}
else {
vErrors.push(err15);
}
errors++;
}
}
}
else {
const err16 = {instancePath:instancePath+"/scope",schemaPath:"#/properties/scope/type",keyword:"type",params:{type: "array"},message:"must be array"};
if(vErrors === null){
vErrors = [err16];
}
else {
vErrors.push(err16);
}
errors++;
}
}
if(data.acceptance_criteria !== undefined){
let data3 = data.acceptance_criteria;
if(Array.isArray(data3)){
if(data3.length < 1){
const err17 = {instancePath:instancePath+"/acceptance_criteria",schemaPath:"#/properties/acceptance_criteria/minItems",keyword:"minItems",params:{limit: 1},message:"must NOT have fewer than 1 items"};
if(vErrors === null){
vErrors = [err17];
}
else {
vErrors.push(err17);
}
errors++;
}
const len1 = data3.length;
for(let i1=0; i1<len1; i1++){
let data4 = data3[i1];
if(typeof data4 === "string"){
if(func2(data4) < 1){
const err18 = {instancePath:instancePath+"/acceptance_criteria/" + i1,schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err18];
}
else {
vErrors.push(err18);
}
errors++;
}
if(!pattern0.test(data4)){
const err19 = {instancePath:instancePath+"/acceptance_criteria/" + i1,schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err19];
}
else {
vErrors.push(err19);
}
errors++;
}
}
else {
const err20 = {instancePath:instancePath+"/acceptance_criteria/" + i1,schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err20];
}
else {
vErrors.push(err20);
}
errors++;
}
}
}
else {
const err21 = {instancePath:instancePath+"/acceptance_criteria",schemaPath:"#/properties/acceptance_criteria/type",keyword:"type",params:{type: "array"},message:"must be array"};
if(vErrors === null){
vErrors = [err21];
}
else {
vErrors.push(err21);
}
errors++;
}
}
if(data.constraints !== undefined){
if(!(validate12(data.constraints, {instancePath:instancePath+"/constraints",parentData:data,parentDataProperty:"constraints",rootData}))){
vErrors = vErrors === null ? validate12.errors : vErrors.concat(validate12.errors);
errors = vErrors.length;
}
}
if(data.required_checks !== undefined){
let data6 = data.required_checks;
if(Array.isArray(data6)){
if(data6.length < 0){
const err22 = {instancePath:instancePath+"/required_checks",schemaPath:"#/properties/required_checks/minItems",keyword:"minItems",params:{limit: 0},message:"must NOT have fewer than 0 items"};
if(vErrors === null){
vErrors = [err22];
}
else {
vErrors.push(err22);
}
errors++;
}
const len2 = data6.length;
for(let i2=0; i2<len2; i2++){
let data7 = data6[i2];
if(data7 && typeof data7 == "object" && !Array.isArray(data7)){
if(data7.name === undefined){
const err23 = {instancePath:instancePath+"/required_checks/" + i2,schemaPath:"#/properties/required_checks/items/required",keyword:"required",params:{missingProperty: "name"},message:"must have required property '"+"name"+"'"};
if(vErrors === null){
vErrors = [err23];
}
else {
vErrors.push(err23);
}
errors++;
}
if(data7.command === undefined){
const err24 = {instancePath:instancePath+"/required_checks/" + i2,schemaPath:"#/properties/required_checks/items/required",keyword:"required",params:{missingProperty: "command"},message:"must have required property '"+"command"+"'"};
if(vErrors === null){
vErrors = [err24];
}
else {
vErrors.push(err24);
}
errors++;
}
for(const key1 in data7){
if(!((key1 === "name") || (key1 === "command"))){
const err25 = {instancePath:instancePath+"/required_checks/" + i2,schemaPath:"#/properties/required_checks/items/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err25];
}
else {
vErrors.push(err25);
}
errors++;
}
}
if(data7.name !== undefined){
let data8 = data7.name;
if(typeof data8 === "string"){
if(func2(data8) < 1){
const err26 = {instancePath:instancePath+"/required_checks/" + i2+"/name",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err26];
}
else {
vErrors.push(err26);
}
errors++;
}
if(!pattern0.test(data8)){
const err27 = {instancePath:instancePath+"/required_checks/" + i2+"/name",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err27];
}
else {
vErrors.push(err27);
}
errors++;
}
}
else {
const err28 = {instancePath:instancePath+"/required_checks/" + i2+"/name",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err28];
}
else {
vErrors.push(err28);
}
errors++;
}
}
if(data7.command !== undefined){
let data9 = data7.command;
if(typeof data9 === "string"){
if(func2(data9) < 1){
const err29 = {instancePath:instancePath+"/required_checks/" + i2+"/command",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err29];
}
else {
vErrors.push(err29);
}
errors++;
}
if(!pattern0.test(data9)){
const err30 = {instancePath:instancePath+"/required_checks/" + i2+"/command",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err30];
}
else {
vErrors.push(err30);
}
errors++;
}
}
else {
const err31 = {instancePath:instancePath+"/required_checks/" + i2+"/command",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err31];
}
else {
vErrors.push(err31);
}
errors++;
}
}
}
else {
const err32 = {instancePath:instancePath+"/required_checks/" + i2,schemaPath:"#/properties/required_checks/items/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err32];
}
else {
vErrors.push(err32);
}
errors++;
}
}
}
else {
const err33 = {instancePath:instancePath+"/required_checks",schemaPath:"#/properties/required_checks/type",keyword:"type",params:{type: "array"},message:"must be array"};
if(vErrors === null){
vErrors = [err33];
}
else {
vErrors.push(err33);
}
errors++;
}
}
if(data.delivery !== undefined){
let data10 = data.delivery;
if(data10 && typeof data10 == "object" && !Array.isArray(data10)){
if(data10.mode === undefined){
const err34 = {instancePath:instancePath+"/delivery",schemaPath:"#/properties/delivery/required",keyword:"required",params:{missingProperty: "mode"},message:"must have required property '"+"mode"+"'"};
if(vErrors === null){
vErrors = [err34];
}
else {
vErrors.push(err34);
}
errors++;
}
if(data10.target === undefined){
const err35 = {instancePath:instancePath+"/delivery",schemaPath:"#/properties/delivery/required",keyword:"required",params:{missingProperty: "target"},message:"must have required property '"+"target"+"'"};
if(vErrors === null){
vErrors = [err35];
}
else {
vErrors.push(err35);
}
errors++;
}
if(data10.authorization === undefined){
const err36 = {instancePath:instancePath+"/delivery",schemaPath:"#/properties/delivery/required",keyword:"required",params:{missingProperty: "authorization"},message:"must have required property '"+"authorization"+"'"};
if(vErrors === null){
vErrors = [err36];
}
else {
vErrors.push(err36);
}
errors++;
}
for(const key2 in data10){
if(!(((key2 === "mode") || (key2 === "target")) || (key2 === "authorization"))){
const err37 = {instancePath:instancePath+"/delivery",schemaPath:"#/properties/delivery/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err37];
}
else {
vErrors.push(err37);
}
errors++;
}
}
if(data10.mode !== undefined){
let data11 = data10.mode;
if(typeof data11 !== "string"){
const err38 = {instancePath:instancePath+"/delivery/mode",schemaPath:"#/properties/delivery/properties/mode/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err38];
}
else {
vErrors.push(err38);
}
errors++;
}
if(!(((((data11 === "none") || (data11 === "commit")) || (data11 === "pr")) || (data11 === "merge")) || (data11 === "artifact"))){
const err39 = {instancePath:instancePath+"/delivery/mode",schemaPath:"#/properties/delivery/properties/mode/enum",keyword:"enum",params:{allowedValues: schema40.properties.delivery.properties.mode.enum},message:"must be equal to one of the allowed values"};
if(vErrors === null){
vErrors = [err39];
}
else {
vErrors.push(err39);
}
errors++;
}
}
if(data10.target !== undefined){
let data12 = data10.target;
const _errs33 = errors;
let valid14 = false;
const _errs34 = errors;
if(typeof data12 === "string"){
if(func2(data12) < 1){
const err40 = {instancePath:instancePath+"/delivery/target",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err40];
}
else {
vErrors.push(err40);
}
errors++;
}
if(!pattern0.test(data12)){
const err41 = {instancePath:instancePath+"/delivery/target",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err41];
}
else {
vErrors.push(err41);
}
errors++;
}
}
else {
const err42 = {instancePath:instancePath+"/delivery/target",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err42];
}
else {
vErrors.push(err42);
}
errors++;
}
var _valid0 = _errs34 === errors;
valid14 = valid14 || _valid0;
if(!valid14){
const _errs37 = errors;
if(data12 !== null){
const err43 = {instancePath:instancePath+"/delivery/target",schemaPath:"#/properties/delivery/properties/target/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err43];
}
else {
vErrors.push(err43);
}
errors++;
}
var _valid0 = _errs37 === errors;
valid14 = valid14 || _valid0;
}
if(!valid14){
const err44 = {instancePath:instancePath+"/delivery/target",schemaPath:"#/properties/delivery/properties/target/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err44];
}
else {
vErrors.push(err44);
}
errors++;
}
else {
errors = _errs33;
if(vErrors !== null){
if(_errs33){
vErrors.length = _errs33;
}
else {
vErrors = null;
}
}
}
}
if(data10.authorization !== undefined){
let data13 = data10.authorization;
const _errs40 = errors;
let valid16 = false;
const _errs41 = errors;
if(typeof data13 === "string"){
if(func2(data13) < 1){
const err45 = {instancePath:instancePath+"/delivery/authorization",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err45];
}
else {
vErrors.push(err45);
}
errors++;
}
if(!pattern0.test(data13)){
const err46 = {instancePath:instancePath+"/delivery/authorization",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err46];
}
else {
vErrors.push(err46);
}
errors++;
}
}
else {
const err47 = {instancePath:instancePath+"/delivery/authorization",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err47];
}
else {
vErrors.push(err47);
}
errors++;
}
var _valid1 = _errs41 === errors;
valid16 = valid16 || _valid1;
if(!valid16){
const _errs44 = errors;
if(data13 !== null){
const err48 = {instancePath:instancePath+"/delivery/authorization",schemaPath:"#/properties/delivery/properties/authorization/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err48];
}
else {
vErrors.push(err48);
}
errors++;
}
var _valid1 = _errs44 === errors;
valid16 = valid16 || _valid1;
}
if(!valid16){
const err49 = {instancePath:instancePath+"/delivery/authorization",schemaPath:"#/properties/delivery/properties/authorization/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err49];
}
else {
vErrors.push(err49);
}
errors++;
}
else {
errors = _errs40;
if(vErrors !== null){
if(_errs40){
vErrors.length = _errs40;
}
else {
vErrors = null;
}
}
}
}
}
else {
const err50 = {instancePath:instancePath+"/delivery",schemaPath:"#/properties/delivery/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err50];
}
else {
vErrors.push(err50);
}
errors++;
}
}
if(data.cleanup_required !== undefined){
if(typeof data.cleanup_required !== "boolean"){
const err51 = {instancePath:instancePath+"/cleanup_required",schemaPath:"#/properties/cleanup_required/type",keyword:"type",params:{type: "boolean"},message:"must be boolean"};
if(vErrors === null){
vErrors = [err51];
}
else {
vErrors.push(err51);
}
errors++;
}
}
if(data.evidence !== undefined){
let data15 = data.evidence;
if(Array.isArray(data15)){
if(data15.length < 0){
const err52 = {instancePath:instancePath+"/evidence",schemaPath:"#/properties/evidence/minItems",keyword:"minItems",params:{limit: 0},message:"must NOT have fewer than 0 items"};
if(vErrors === null){
vErrors = [err52];
}
else {
vErrors.push(err52);
}
errors++;
}
const len3 = data15.length;
for(let i3=0; i3<len3; i3++){
if(!(validate16(data15[i3], {instancePath:instancePath+"/evidence/" + i3,parentData:data15,parentDataProperty:i3,rootData}))){
vErrors = vErrors === null ? validate16.errors : vErrors.concat(validate16.errors);
errors = vErrors.length;
}
}
}
else {
const err53 = {instancePath:instancePath+"/evidence",schemaPath:"#/properties/evidence/type",keyword:"type",params:{type: "array"},message:"must be array"};
if(vErrors === null){
vErrors = [err53];
}
else {
vErrors.push(err53);
}
errors++;
}
}
}
else {
const err54 = {instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err54];
}
else {
vErrors.push(err54);
}
errors++;
}
validate37.errors = vErrors;
return errors === 0;
}

const schema48 = {"type":"object","additionalProperties":false,"required":["summary","outcome","acceptance_results","checks","ci","delivery","cleanup","remaining","uncertainties","evidence"],"properties":{"summary":{"$ref":"#/definitions/text"},"outcome":{"type":"string","enum":["completed","incomplete"]},"acceptance_results":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["criterion","result","evidence"],"properties":{"criterion":{"$ref":"#/definitions/text"},"result":{"type":"string","enum":["met","unmet","unknown"]},"evidence":{"type":"array","items":{"$ref":"#/definitions/evidence"},"minItems":0}}},"minItems":1},"checks":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["name","required","status","command","evidence"],"properties":{"name":{"$ref":"#/definitions/text"},"required":{"type":"boolean"},"status":{"type":"string","enum":["passed","failed","unknown","skipped","unregistered"]},"command":{"$ref":"#/definitions/text"},"evidence":{"type":"array","items":{"$ref":"#/definitions/evidence"},"minItems":0}}},"minItems":0},"ci":{"type":"array","items":{"$ref":"#/definitions/ci"},"minItems":0},"delivery":{"$ref":"#/definitions/delivery"},"cleanup":{"$ref":"#/definitions/cleanup"},"remaining":{"$ref":"#/definitions/texts"},"uncertainties":{"$ref":"#/definitions/texts"},"evidence":{"type":"array","items":{"$ref":"#/definitions/evidence"},"minItems":0}}};

function validate41(data, {instancePath="", parentData, parentDataProperty, rootData=data}={}){
let vErrors = null;
let errors = 0;
if(data && typeof data == "object" && !Array.isArray(data)){
if(data.summary === undefined){
const err0 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "summary"},message:"must have required property '"+"summary"+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
if(data.outcome === undefined){
const err1 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "outcome"},message:"must have required property '"+"outcome"+"'"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
}
if(data.acceptance_results === undefined){
const err2 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "acceptance_results"},message:"must have required property '"+"acceptance_results"+"'"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
if(data.checks === undefined){
const err3 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "checks"},message:"must have required property '"+"checks"+"'"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
if(data.ci === undefined){
const err4 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "ci"},message:"must have required property '"+"ci"+"'"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
if(data.delivery === undefined){
const err5 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "delivery"},message:"must have required property '"+"delivery"+"'"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
if(data.cleanup === undefined){
const err6 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "cleanup"},message:"must have required property '"+"cleanup"+"'"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
}
if(data.remaining === undefined){
const err7 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "remaining"},message:"must have required property '"+"remaining"+"'"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
if(data.uncertainties === undefined){
const err8 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "uncertainties"},message:"must have required property '"+"uncertainties"+"'"};
if(vErrors === null){
vErrors = [err8];
}
else {
vErrors.push(err8);
}
errors++;
}
if(data.evidence === undefined){
const err9 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "evidence"},message:"must have required property '"+"evidence"+"'"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
}
for(const key0 in data){
if(!(func8.call(schema48.properties, key0))){
const err10 = {instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
}
if(data.summary !== undefined){
let data0 = data.summary;
if(typeof data0 === "string"){
if(func2(data0) < 1){
const err11 = {instancePath:instancePath+"/summary",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
}
if(!pattern0.test(data0)){
const err12 = {instancePath:instancePath+"/summary",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err12];
}
else {
vErrors.push(err12);
}
errors++;
}
}
else {
const err13 = {instancePath:instancePath+"/summary",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err13];
}
else {
vErrors.push(err13);
}
errors++;
}
}
if(data.outcome !== undefined){
let data1 = data.outcome;
if(typeof data1 !== "string"){
const err14 = {instancePath:instancePath+"/outcome",schemaPath:"#/properties/outcome/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err14];
}
else {
vErrors.push(err14);
}
errors++;
}
if(!((data1 === "completed") || (data1 === "incomplete"))){
const err15 = {instancePath:instancePath+"/outcome",schemaPath:"#/properties/outcome/enum",keyword:"enum",params:{allowedValues: schema48.properties.outcome.enum},message:"must be equal to one of the allowed values"};
if(vErrors === null){
vErrors = [err15];
}
else {
vErrors.push(err15);
}
errors++;
}
}
if(data.acceptance_results !== undefined){
let data2 = data.acceptance_results;
if(Array.isArray(data2)){
if(data2.length < 1){
const err16 = {instancePath:instancePath+"/acceptance_results",schemaPath:"#/properties/acceptance_results/minItems",keyword:"minItems",params:{limit: 1},message:"must NOT have fewer than 1 items"};
if(vErrors === null){
vErrors = [err16];
}
else {
vErrors.push(err16);
}
errors++;
}
const len0 = data2.length;
for(let i0=0; i0<len0; i0++){
let data3 = data2[i0];
if(data3 && typeof data3 == "object" && !Array.isArray(data3)){
if(data3.criterion === undefined){
const err17 = {instancePath:instancePath+"/acceptance_results/" + i0,schemaPath:"#/properties/acceptance_results/items/required",keyword:"required",params:{missingProperty: "criterion"},message:"must have required property '"+"criterion"+"'"};
if(vErrors === null){
vErrors = [err17];
}
else {
vErrors.push(err17);
}
errors++;
}
if(data3.result === undefined){
const err18 = {instancePath:instancePath+"/acceptance_results/" + i0,schemaPath:"#/properties/acceptance_results/items/required",keyword:"required",params:{missingProperty: "result"},message:"must have required property '"+"result"+"'"};
if(vErrors === null){
vErrors = [err18];
}
else {
vErrors.push(err18);
}
errors++;
}
if(data3.evidence === undefined){
const err19 = {instancePath:instancePath+"/acceptance_results/" + i0,schemaPath:"#/properties/acceptance_results/items/required",keyword:"required",params:{missingProperty: "evidence"},message:"must have required property '"+"evidence"+"'"};
if(vErrors === null){
vErrors = [err19];
}
else {
vErrors.push(err19);
}
errors++;
}
for(const key1 in data3){
if(!(((key1 === "criterion") || (key1 === "result")) || (key1 === "evidence"))){
const err20 = {instancePath:instancePath+"/acceptance_results/" + i0,schemaPath:"#/properties/acceptance_results/items/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err20];
}
else {
vErrors.push(err20);
}
errors++;
}
}
if(data3.criterion !== undefined){
let data4 = data3.criterion;
if(typeof data4 === "string"){
if(func2(data4) < 1){
const err21 = {instancePath:instancePath+"/acceptance_results/" + i0+"/criterion",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err21];
}
else {
vErrors.push(err21);
}
errors++;
}
if(!pattern0.test(data4)){
const err22 = {instancePath:instancePath+"/acceptance_results/" + i0+"/criterion",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err22];
}
else {
vErrors.push(err22);
}
errors++;
}
}
else {
const err23 = {instancePath:instancePath+"/acceptance_results/" + i0+"/criterion",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err23];
}
else {
vErrors.push(err23);
}
errors++;
}
}
if(data3.result !== undefined){
let data5 = data3.result;
if(typeof data5 !== "string"){
const err24 = {instancePath:instancePath+"/acceptance_results/" + i0+"/result",schemaPath:"#/properties/acceptance_results/items/properties/result/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err24];
}
else {
vErrors.push(err24);
}
errors++;
}
if(!(((data5 === "met") || (data5 === "unmet")) || (data5 === "unknown"))){
const err25 = {instancePath:instancePath+"/acceptance_results/" + i0+"/result",schemaPath:"#/properties/acceptance_results/items/properties/result/enum",keyword:"enum",params:{allowedValues: schema48.properties.acceptance_results.items.properties.result.enum},message:"must be equal to one of the allowed values"};
if(vErrors === null){
vErrors = [err25];
}
else {
vErrors.push(err25);
}
errors++;
}
}
if(data3.evidence !== undefined){
let data6 = data3.evidence;
if(Array.isArray(data6)){
if(data6.length < 0){
const err26 = {instancePath:instancePath+"/acceptance_results/" + i0+"/evidence",schemaPath:"#/properties/acceptance_results/items/properties/evidence/minItems",keyword:"minItems",params:{limit: 0},message:"must NOT have fewer than 0 items"};
if(vErrors === null){
vErrors = [err26];
}
else {
vErrors.push(err26);
}
errors++;
}
const len1 = data6.length;
for(let i1=0; i1<len1; i1++){
if(!(validate16(data6[i1], {instancePath:instancePath+"/acceptance_results/" + i0+"/evidence/" + i1,parentData:data6,parentDataProperty:i1,rootData}))){
vErrors = vErrors === null ? validate16.errors : vErrors.concat(validate16.errors);
errors = vErrors.length;
}
}
}
else {
const err27 = {instancePath:instancePath+"/acceptance_results/" + i0+"/evidence",schemaPath:"#/properties/acceptance_results/items/properties/evidence/type",keyword:"type",params:{type: "array"},message:"must be array"};
if(vErrors === null){
vErrors = [err27];
}
else {
vErrors.push(err27);
}
errors++;
}
}
}
else {
const err28 = {instancePath:instancePath+"/acceptance_results/" + i0,schemaPath:"#/properties/acceptance_results/items/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err28];
}
else {
vErrors.push(err28);
}
errors++;
}
}
}
else {
const err29 = {instancePath:instancePath+"/acceptance_results",schemaPath:"#/properties/acceptance_results/type",keyword:"type",params:{type: "array"},message:"must be array"};
if(vErrors === null){
vErrors = [err29];
}
else {
vErrors.push(err29);
}
errors++;
}
}
if(data.checks !== undefined){
let data8 = data.checks;
if(Array.isArray(data8)){
if(data8.length < 0){
const err30 = {instancePath:instancePath+"/checks",schemaPath:"#/properties/checks/minItems",keyword:"minItems",params:{limit: 0},message:"must NOT have fewer than 0 items"};
if(vErrors === null){
vErrors = [err30];
}
else {
vErrors.push(err30);
}
errors++;
}
const len2 = data8.length;
for(let i2=0; i2<len2; i2++){
let data9 = data8[i2];
if(data9 && typeof data9 == "object" && !Array.isArray(data9)){
if(data9.name === undefined){
const err31 = {instancePath:instancePath+"/checks/" + i2,schemaPath:"#/properties/checks/items/required",keyword:"required",params:{missingProperty: "name"},message:"must have required property '"+"name"+"'"};
if(vErrors === null){
vErrors = [err31];
}
else {
vErrors.push(err31);
}
errors++;
}
if(data9.required === undefined){
const err32 = {instancePath:instancePath+"/checks/" + i2,schemaPath:"#/properties/checks/items/required",keyword:"required",params:{missingProperty: "required"},message:"must have required property '"+"required"+"'"};
if(vErrors === null){
vErrors = [err32];
}
else {
vErrors.push(err32);
}
errors++;
}
if(data9.status === undefined){
const err33 = {instancePath:instancePath+"/checks/" + i2,schemaPath:"#/properties/checks/items/required",keyword:"required",params:{missingProperty: "status"},message:"must have required property '"+"status"+"'"};
if(vErrors === null){
vErrors = [err33];
}
else {
vErrors.push(err33);
}
errors++;
}
if(data9.command === undefined){
const err34 = {instancePath:instancePath+"/checks/" + i2,schemaPath:"#/properties/checks/items/required",keyword:"required",params:{missingProperty: "command"},message:"must have required property '"+"command"+"'"};
if(vErrors === null){
vErrors = [err34];
}
else {
vErrors.push(err34);
}
errors++;
}
if(data9.evidence === undefined){
const err35 = {instancePath:instancePath+"/checks/" + i2,schemaPath:"#/properties/checks/items/required",keyword:"required",params:{missingProperty: "evidence"},message:"must have required property '"+"evidence"+"'"};
if(vErrors === null){
vErrors = [err35];
}
else {
vErrors.push(err35);
}
errors++;
}
for(const key2 in data9){
if(!(((((key2 === "name") || (key2 === "required")) || (key2 === "status")) || (key2 === "command")) || (key2 === "evidence"))){
const err36 = {instancePath:instancePath+"/checks/" + i2,schemaPath:"#/properties/checks/items/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err36];
}
else {
vErrors.push(err36);
}
errors++;
}
}
if(data9.name !== undefined){
let data10 = data9.name;
if(typeof data10 === "string"){
if(func2(data10) < 1){
const err37 = {instancePath:instancePath+"/checks/" + i2+"/name",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err37];
}
else {
vErrors.push(err37);
}
errors++;
}
if(!pattern0.test(data10)){
const err38 = {instancePath:instancePath+"/checks/" + i2+"/name",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err38];
}
else {
vErrors.push(err38);
}
errors++;
}
}
else {
const err39 = {instancePath:instancePath+"/checks/" + i2+"/name",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err39];
}
else {
vErrors.push(err39);
}
errors++;
}
}
if(data9.required !== undefined){
if(typeof data9.required !== "boolean"){
const err40 = {instancePath:instancePath+"/checks/" + i2+"/required",schemaPath:"#/properties/checks/items/properties/required/type",keyword:"type",params:{type: "boolean"},message:"must be boolean"};
if(vErrors === null){
vErrors = [err40];
}
else {
vErrors.push(err40);
}
errors++;
}
}
if(data9.status !== undefined){
let data12 = data9.status;
if(typeof data12 !== "string"){
const err41 = {instancePath:instancePath+"/checks/" + i2+"/status",schemaPath:"#/properties/checks/items/properties/status/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err41];
}
else {
vErrors.push(err41);
}
errors++;
}
if(!(((((data12 === "passed") || (data12 === "failed")) || (data12 === "unknown")) || (data12 === "skipped")) || (data12 === "unregistered"))){
const err42 = {instancePath:instancePath+"/checks/" + i2+"/status",schemaPath:"#/properties/checks/items/properties/status/enum",keyword:"enum",params:{allowedValues: schema48.properties.checks.items.properties.status.enum},message:"must be equal to one of the allowed values"};
if(vErrors === null){
vErrors = [err42];
}
else {
vErrors.push(err42);
}
errors++;
}
}
if(data9.command !== undefined){
let data13 = data9.command;
if(typeof data13 === "string"){
if(func2(data13) < 1){
const err43 = {instancePath:instancePath+"/checks/" + i2+"/command",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err43];
}
else {
vErrors.push(err43);
}
errors++;
}
if(!pattern0.test(data13)){
const err44 = {instancePath:instancePath+"/checks/" + i2+"/command",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err44];
}
else {
vErrors.push(err44);
}
errors++;
}
}
else {
const err45 = {instancePath:instancePath+"/checks/" + i2+"/command",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err45];
}
else {
vErrors.push(err45);
}
errors++;
}
}
if(data9.evidence !== undefined){
let data14 = data9.evidence;
if(Array.isArray(data14)){
if(data14.length < 0){
const err46 = {instancePath:instancePath+"/checks/" + i2+"/evidence",schemaPath:"#/properties/checks/items/properties/evidence/minItems",keyword:"minItems",params:{limit: 0},message:"must NOT have fewer than 0 items"};
if(vErrors === null){
vErrors = [err46];
}
else {
vErrors.push(err46);
}
errors++;
}
const len3 = data14.length;
for(let i3=0; i3<len3; i3++){
if(!(validate16(data14[i3], {instancePath:instancePath+"/checks/" + i2+"/evidence/" + i3,parentData:data14,parentDataProperty:i3,rootData}))){
vErrors = vErrors === null ? validate16.errors : vErrors.concat(validate16.errors);
errors = vErrors.length;
}
}
}
else {
const err47 = {instancePath:instancePath+"/checks/" + i2+"/evidence",schemaPath:"#/properties/checks/items/properties/evidence/type",keyword:"type",params:{type: "array"},message:"must be array"};
if(vErrors === null){
vErrors = [err47];
}
else {
vErrors.push(err47);
}
errors++;
}
}
}
else {
const err48 = {instancePath:instancePath+"/checks/" + i2,schemaPath:"#/properties/checks/items/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err48];
}
else {
vErrors.push(err48);
}
errors++;
}
}
}
else {
const err49 = {instancePath:instancePath+"/checks",schemaPath:"#/properties/checks/type",keyword:"type",params:{type: "array"},message:"must be array"};
if(vErrors === null){
vErrors = [err49];
}
else {
vErrors.push(err49);
}
errors++;
}
}
if(data.ci !== undefined){
let data16 = data.ci;
if(Array.isArray(data16)){
if(data16.length < 0){
const err50 = {instancePath:instancePath+"/ci",schemaPath:"#/properties/ci/minItems",keyword:"minItems",params:{limit: 0},message:"must NOT have fewer than 0 items"};
if(vErrors === null){
vErrors = [err50];
}
else {
vErrors.push(err50);
}
errors++;
}
const len4 = data16.length;
for(let i4=0; i4<len4; i4++){
if(!(validate26(data16[i4], {instancePath:instancePath+"/ci/" + i4,parentData:data16,parentDataProperty:i4,rootData}))){
vErrors = vErrors === null ? validate26.errors : vErrors.concat(validate26.errors);
errors = vErrors.length;
}
}
}
else {
const err51 = {instancePath:instancePath+"/ci",schemaPath:"#/properties/ci/type",keyword:"type",params:{type: "array"},message:"must be array"};
if(vErrors === null){
vErrors = [err51];
}
else {
vErrors.push(err51);
}
errors++;
}
}
if(data.delivery !== undefined){
if(!(validate28(data.delivery, {instancePath:instancePath+"/delivery",parentData:data,parentDataProperty:"delivery",rootData}))){
vErrors = vErrors === null ? validate28.errors : vErrors.concat(validate28.errors);
errors = vErrors.length;
}
}
if(data.cleanup !== undefined){
if(!(validate30(data.cleanup, {instancePath:instancePath+"/cleanup",parentData:data,parentDataProperty:"cleanup",rootData}))){
vErrors = vErrors === null ? validate30.errors : vErrors.concat(validate30.errors);
errors = vErrors.length;
}
}
if(data.remaining !== undefined){
if(!(validate12(data.remaining, {instancePath:instancePath+"/remaining",parentData:data,parentDataProperty:"remaining",rootData}))){
vErrors = vErrors === null ? validate12.errors : vErrors.concat(validate12.errors);
errors = vErrors.length;
}
}
if(data.uncertainties !== undefined){
if(!(validate12(data.uncertainties, {instancePath:instancePath+"/uncertainties",parentData:data,parentDataProperty:"uncertainties",rootData}))){
vErrors = vErrors === null ? validate12.errors : vErrors.concat(validate12.errors);
errors = vErrors.length;
}
}
if(data.evidence !== undefined){
let data22 = data.evidence;
if(Array.isArray(data22)){
if(data22.length < 0){
const err52 = {instancePath:instancePath+"/evidence",schemaPath:"#/properties/evidence/minItems",keyword:"minItems",params:{limit: 0},message:"must NOT have fewer than 0 items"};
if(vErrors === null){
vErrors = [err52];
}
else {
vErrors.push(err52);
}
errors++;
}
const len5 = data22.length;
for(let i5=0; i5<len5; i5++){
if(!(validate16(data22[i5], {instancePath:instancePath+"/evidence/" + i5,parentData:data22,parentDataProperty:i5,rootData}))){
vErrors = vErrors === null ? validate16.errors : vErrors.concat(validate16.errors);
errors = vErrors.length;
}
}
}
else {
const err53 = {instancePath:instancePath+"/evidence",schemaPath:"#/properties/evidence/type",keyword:"type",params:{type: "array"},message:"must be array"};
if(vErrors === null){
vErrors = [err53];
}
else {
vErrors.push(err53);
}
errors++;
}
}
}
else {
const err54 = {instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err54];
}
else {
vErrors.push(err54);
}
errors++;
}
validate41.errors = vErrors;
return errors === 0;
}

const schema54 = {"type":"object","additionalProperties":false,"required":["summary","reason","undelivered_changes","sessions","delivery","cleanup","resume_steps","uncertainties","evidence"],"properties":{"summary":{"$ref":"#/definitions/text"},"reason":{"$ref":"#/definitions/text"},"undelivered_changes":{"$ref":"#/definitions/texts"},"sessions":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["session_id","worktree_id","instance_id","liveness","action","stop_authorization"],"properties":{"session_id":{"$ref":"#/definitions/text"},"worktree_id":{"$ref":"#/definitions/text"},"instance_id":{"$ref":"#/definitions/text"},"liveness":{"type":"string","enum":["running","exited","unknown"]},"action":{"type":"string","enum":["preserved","stop_requested","stopped"]},"stop_authorization":{"anyOf":[{"$ref":"#/definitions/text"},{"type":"null"}]}}},"minItems":0},"delivery":{"$ref":"#/definitions/delivery"},"cleanup":{"$ref":"#/definitions/cleanup"},"resume_steps":{"type":"array","items":{"$ref":"#/definitions/text"},"minItems":1},"uncertainties":{"$ref":"#/definitions/texts"},"evidence":{"type":"array","items":{"$ref":"#/definitions/evidence"},"minItems":0}}};

function validate51(data, {instancePath="", parentData, parentDataProperty, rootData=data}={}){
let vErrors = null;
let errors = 0;
if(data && typeof data == "object" && !Array.isArray(data)){
if(data.summary === undefined){
const err0 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "summary"},message:"must have required property '"+"summary"+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
if(data.reason === undefined){
const err1 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "reason"},message:"must have required property '"+"reason"+"'"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
}
if(data.undelivered_changes === undefined){
const err2 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "undelivered_changes"},message:"must have required property '"+"undelivered_changes"+"'"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
if(data.sessions === undefined){
const err3 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "sessions"},message:"must have required property '"+"sessions"+"'"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
if(data.delivery === undefined){
const err4 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "delivery"},message:"must have required property '"+"delivery"+"'"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
if(data.cleanup === undefined){
const err5 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "cleanup"},message:"must have required property '"+"cleanup"+"'"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
if(data.resume_steps === undefined){
const err6 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "resume_steps"},message:"must have required property '"+"resume_steps"+"'"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
}
if(data.uncertainties === undefined){
const err7 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "uncertainties"},message:"must have required property '"+"uncertainties"+"'"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
if(data.evidence === undefined){
const err8 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "evidence"},message:"must have required property '"+"evidence"+"'"};
if(vErrors === null){
vErrors = [err8];
}
else {
vErrors.push(err8);
}
errors++;
}
for(const key0 in data){
if(!(func8.call(schema54.properties, key0))){
const err9 = {instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
}
}
if(data.summary !== undefined){
let data0 = data.summary;
if(typeof data0 === "string"){
if(func2(data0) < 1){
const err10 = {instancePath:instancePath+"/summary",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
if(!pattern0.test(data0)){
const err11 = {instancePath:instancePath+"/summary",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
}
}
else {
const err12 = {instancePath:instancePath+"/summary",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err12];
}
else {
vErrors.push(err12);
}
errors++;
}
}
if(data.reason !== undefined){
let data1 = data.reason;
if(typeof data1 === "string"){
if(func2(data1) < 1){
const err13 = {instancePath:instancePath+"/reason",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err13];
}
else {
vErrors.push(err13);
}
errors++;
}
if(!pattern0.test(data1)){
const err14 = {instancePath:instancePath+"/reason",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err14];
}
else {
vErrors.push(err14);
}
errors++;
}
}
else {
const err15 = {instancePath:instancePath+"/reason",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err15];
}
else {
vErrors.push(err15);
}
errors++;
}
}
if(data.undelivered_changes !== undefined){
if(!(validate12(data.undelivered_changes, {instancePath:instancePath+"/undelivered_changes",parentData:data,parentDataProperty:"undelivered_changes",rootData}))){
vErrors = vErrors === null ? validate12.errors : vErrors.concat(validate12.errors);
errors = vErrors.length;
}
}
if(data.sessions !== undefined){
let data3 = data.sessions;
if(Array.isArray(data3)){
if(data3.length < 0){
const err16 = {instancePath:instancePath+"/sessions",schemaPath:"#/properties/sessions/minItems",keyword:"minItems",params:{limit: 0},message:"must NOT have fewer than 0 items"};
if(vErrors === null){
vErrors = [err16];
}
else {
vErrors.push(err16);
}
errors++;
}
const len0 = data3.length;
for(let i0=0; i0<len0; i0++){
let data4 = data3[i0];
if(data4 && typeof data4 == "object" && !Array.isArray(data4)){
if(data4.session_id === undefined){
const err17 = {instancePath:instancePath+"/sessions/" + i0,schemaPath:"#/properties/sessions/items/required",keyword:"required",params:{missingProperty: "session_id"},message:"must have required property '"+"session_id"+"'"};
if(vErrors === null){
vErrors = [err17];
}
else {
vErrors.push(err17);
}
errors++;
}
if(data4.worktree_id === undefined){
const err18 = {instancePath:instancePath+"/sessions/" + i0,schemaPath:"#/properties/sessions/items/required",keyword:"required",params:{missingProperty: "worktree_id"},message:"must have required property '"+"worktree_id"+"'"};
if(vErrors === null){
vErrors = [err18];
}
else {
vErrors.push(err18);
}
errors++;
}
if(data4.instance_id === undefined){
const err19 = {instancePath:instancePath+"/sessions/" + i0,schemaPath:"#/properties/sessions/items/required",keyword:"required",params:{missingProperty: "instance_id"},message:"must have required property '"+"instance_id"+"'"};
if(vErrors === null){
vErrors = [err19];
}
else {
vErrors.push(err19);
}
errors++;
}
if(data4.liveness === undefined){
const err20 = {instancePath:instancePath+"/sessions/" + i0,schemaPath:"#/properties/sessions/items/required",keyword:"required",params:{missingProperty: "liveness"},message:"must have required property '"+"liveness"+"'"};
if(vErrors === null){
vErrors = [err20];
}
else {
vErrors.push(err20);
}
errors++;
}
if(data4.action === undefined){
const err21 = {instancePath:instancePath+"/sessions/" + i0,schemaPath:"#/properties/sessions/items/required",keyword:"required",params:{missingProperty: "action"},message:"must have required property '"+"action"+"'"};
if(vErrors === null){
vErrors = [err21];
}
else {
vErrors.push(err21);
}
errors++;
}
if(data4.stop_authorization === undefined){
const err22 = {instancePath:instancePath+"/sessions/" + i0,schemaPath:"#/properties/sessions/items/required",keyword:"required",params:{missingProperty: "stop_authorization"},message:"must have required property '"+"stop_authorization"+"'"};
if(vErrors === null){
vErrors = [err22];
}
else {
vErrors.push(err22);
}
errors++;
}
for(const key1 in data4){
if(!((((((key1 === "session_id") || (key1 === "worktree_id")) || (key1 === "instance_id")) || (key1 === "liveness")) || (key1 === "action")) || (key1 === "stop_authorization"))){
const err23 = {instancePath:instancePath+"/sessions/" + i0,schemaPath:"#/properties/sessions/items/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err23];
}
else {
vErrors.push(err23);
}
errors++;
}
}
if(data4.session_id !== undefined){
let data5 = data4.session_id;
if(typeof data5 === "string"){
if(func2(data5) < 1){
const err24 = {instancePath:instancePath+"/sessions/" + i0+"/session_id",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err24];
}
else {
vErrors.push(err24);
}
errors++;
}
if(!pattern0.test(data5)){
const err25 = {instancePath:instancePath+"/sessions/" + i0+"/session_id",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err25];
}
else {
vErrors.push(err25);
}
errors++;
}
}
else {
const err26 = {instancePath:instancePath+"/sessions/" + i0+"/session_id",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err26];
}
else {
vErrors.push(err26);
}
errors++;
}
}
if(data4.worktree_id !== undefined){
let data6 = data4.worktree_id;
if(typeof data6 === "string"){
if(func2(data6) < 1){
const err27 = {instancePath:instancePath+"/sessions/" + i0+"/worktree_id",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err27];
}
else {
vErrors.push(err27);
}
errors++;
}
if(!pattern0.test(data6)){
const err28 = {instancePath:instancePath+"/sessions/" + i0+"/worktree_id",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err28];
}
else {
vErrors.push(err28);
}
errors++;
}
}
else {
const err29 = {instancePath:instancePath+"/sessions/" + i0+"/worktree_id",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err29];
}
else {
vErrors.push(err29);
}
errors++;
}
}
if(data4.instance_id !== undefined){
let data7 = data4.instance_id;
if(typeof data7 === "string"){
if(func2(data7) < 1){
const err30 = {instancePath:instancePath+"/sessions/" + i0+"/instance_id",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err30];
}
else {
vErrors.push(err30);
}
errors++;
}
if(!pattern0.test(data7)){
const err31 = {instancePath:instancePath+"/sessions/" + i0+"/instance_id",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err31];
}
else {
vErrors.push(err31);
}
errors++;
}
}
else {
const err32 = {instancePath:instancePath+"/sessions/" + i0+"/instance_id",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err32];
}
else {
vErrors.push(err32);
}
errors++;
}
}
if(data4.liveness !== undefined){
let data8 = data4.liveness;
if(typeof data8 !== "string"){
const err33 = {instancePath:instancePath+"/sessions/" + i0+"/liveness",schemaPath:"#/properties/sessions/items/properties/liveness/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err33];
}
else {
vErrors.push(err33);
}
errors++;
}
if(!(((data8 === "running") || (data8 === "exited")) || (data8 === "unknown"))){
const err34 = {instancePath:instancePath+"/sessions/" + i0+"/liveness",schemaPath:"#/properties/sessions/items/properties/liveness/enum",keyword:"enum",params:{allowedValues: schema54.properties.sessions.items.properties.liveness.enum},message:"must be equal to one of the allowed values"};
if(vErrors === null){
vErrors = [err34];
}
else {
vErrors.push(err34);
}
errors++;
}
}
if(data4.action !== undefined){
let data9 = data4.action;
if(typeof data9 !== "string"){
const err35 = {instancePath:instancePath+"/sessions/" + i0+"/action",schemaPath:"#/properties/sessions/items/properties/action/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err35];
}
else {
vErrors.push(err35);
}
errors++;
}
if(!(((data9 === "preserved") || (data9 === "stop_requested")) || (data9 === "stopped"))){
const err36 = {instancePath:instancePath+"/sessions/" + i0+"/action",schemaPath:"#/properties/sessions/items/properties/action/enum",keyword:"enum",params:{allowedValues: schema54.properties.sessions.items.properties.action.enum},message:"must be equal to one of the allowed values"};
if(vErrors === null){
vErrors = [err36];
}
else {
vErrors.push(err36);
}
errors++;
}
}
if(data4.stop_authorization !== undefined){
let data10 = data4.stop_authorization;
const _errs28 = errors;
let valid9 = false;
const _errs29 = errors;
if(typeof data10 === "string"){
if(func2(data10) < 1){
const err37 = {instancePath:instancePath+"/sessions/" + i0+"/stop_authorization",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err37];
}
else {
vErrors.push(err37);
}
errors++;
}
if(!pattern0.test(data10)){
const err38 = {instancePath:instancePath+"/sessions/" + i0+"/stop_authorization",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err38];
}
else {
vErrors.push(err38);
}
errors++;
}
}
else {
const err39 = {instancePath:instancePath+"/sessions/" + i0+"/stop_authorization",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err39];
}
else {
vErrors.push(err39);
}
errors++;
}
var _valid0 = _errs29 === errors;
valid9 = valid9 || _valid0;
if(!valid9){
const _errs32 = errors;
if(data10 !== null){
const err40 = {instancePath:instancePath+"/sessions/" + i0+"/stop_authorization",schemaPath:"#/properties/sessions/items/properties/stop_authorization/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err40];
}
else {
vErrors.push(err40);
}
errors++;
}
var _valid0 = _errs32 === errors;
valid9 = valid9 || _valid0;
}
if(!valid9){
const err41 = {instancePath:instancePath+"/sessions/" + i0+"/stop_authorization",schemaPath:"#/properties/sessions/items/properties/stop_authorization/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err41];
}
else {
vErrors.push(err41);
}
errors++;
}
else {
errors = _errs28;
if(vErrors !== null){
if(_errs28){
vErrors.length = _errs28;
}
else {
vErrors = null;
}
}
}
}
}
else {
const err42 = {instancePath:instancePath+"/sessions/" + i0,schemaPath:"#/properties/sessions/items/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err42];
}
else {
vErrors.push(err42);
}
errors++;
}
}
}
else {
const err43 = {instancePath:instancePath+"/sessions",schemaPath:"#/properties/sessions/type",keyword:"type",params:{type: "array"},message:"must be array"};
if(vErrors === null){
vErrors = [err43];
}
else {
vErrors.push(err43);
}
errors++;
}
}
if(data.delivery !== undefined){
if(!(validate28(data.delivery, {instancePath:instancePath+"/delivery",parentData:data,parentDataProperty:"delivery",rootData}))){
vErrors = vErrors === null ? validate28.errors : vErrors.concat(validate28.errors);
errors = vErrors.length;
}
}
if(data.cleanup !== undefined){
if(!(validate30(data.cleanup, {instancePath:instancePath+"/cleanup",parentData:data,parentDataProperty:"cleanup",rootData}))){
vErrors = vErrors === null ? validate30.errors : vErrors.concat(validate30.errors);
errors = vErrors.length;
}
}
if(data.resume_steps !== undefined){
let data13 = data.resume_steps;
if(Array.isArray(data13)){
if(data13.length < 1){
const err44 = {instancePath:instancePath+"/resume_steps",schemaPath:"#/properties/resume_steps/minItems",keyword:"minItems",params:{limit: 1},message:"must NOT have fewer than 1 items"};
if(vErrors === null){
vErrors = [err44];
}
else {
vErrors.push(err44);
}
errors++;
}
const len1 = data13.length;
for(let i1=0; i1<len1; i1++){
let data14 = data13[i1];
if(typeof data14 === "string"){
if(func2(data14) < 1){
const err45 = {instancePath:instancePath+"/resume_steps/" + i1,schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err45];
}
else {
vErrors.push(err45);
}
errors++;
}
if(!pattern0.test(data14)){
const err46 = {instancePath:instancePath+"/resume_steps/" + i1,schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err46];
}
else {
vErrors.push(err46);
}
errors++;
}
}
else {
const err47 = {instancePath:instancePath+"/resume_steps/" + i1,schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err47];
}
else {
vErrors.push(err47);
}
errors++;
}
}
}
else {
const err48 = {instancePath:instancePath+"/resume_steps",schemaPath:"#/properties/resume_steps/type",keyword:"type",params:{type: "array"},message:"must be array"};
if(vErrors === null){
vErrors = [err48];
}
else {
vErrors.push(err48);
}
errors++;
}
}
if(data.uncertainties !== undefined){
if(!(validate12(data.uncertainties, {instancePath:instancePath+"/uncertainties",parentData:data,parentDataProperty:"uncertainties",rootData}))){
vErrors = vErrors === null ? validate12.errors : vErrors.concat(validate12.errors);
errors = vErrors.length;
}
}
if(data.evidence !== undefined){
let data16 = data.evidence;
if(Array.isArray(data16)){
if(data16.length < 0){
const err49 = {instancePath:instancePath+"/evidence",schemaPath:"#/properties/evidence/minItems",keyword:"minItems",params:{limit: 0},message:"must NOT have fewer than 0 items"};
if(vErrors === null){
vErrors = [err49];
}
else {
vErrors.push(err49);
}
errors++;
}
const len2 = data16.length;
for(let i2=0; i2<len2; i2++){
if(!(validate16(data16[i2], {instancePath:instancePath+"/evidence/" + i2,parentData:data16,parentDataProperty:i2,rootData}))){
vErrors = vErrors === null ? validate16.errors : vErrors.concat(validate16.errors);
errors = vErrors.length;
}
}
}
else {
const err50 = {instancePath:instancePath+"/evidence",schemaPath:"#/properties/evidence/type",keyword:"type",params:{type: "array"},message:"must be array"};
if(vErrors === null){
vErrors = [err50];
}
else {
vErrors.push(err50);
}
errors++;
}
}
}
else {
const err51 = {instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err51];
}
else {
vErrors.push(err51);
}
errors++;
}
validate51.errors = vErrors;
return errors === 0;
}


function validate10(data, {instancePath="", parentData, parentDataProperty, rootData=data}={}){
let vErrors = null;
let errors = 0;
const _errs2 = errors;
let valid1 = true;
const _errs3 = errors;
if(data && typeof data == "object" && !Array.isArray(data)){
if(data.kind !== undefined){
if("review_request" !== data.kind){
const err0 = {};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
}
}
var _valid0 = _errs3 === errors;
errors = _errs2;
if(vErrors !== null){
if(_errs2){
vErrors.length = _errs2;
}
else {
vErrors = null;
}
}
if(_valid0){
const _errs5 = errors;
if(data && typeof data == "object" && !Array.isArray(data)){
if(data.payload !== undefined){
if(!(validate11(data.payload, {instancePath:instancePath+"/payload",parentData:data,parentDataProperty:"payload",rootData}))){
vErrors = vErrors === null ? validate11.errors : vErrors.concat(validate11.errors);
errors = vErrors.length;
}
}
}
var _valid0 = _errs5 === errors;
valid1 = _valid0;
}
if(!valid1){
const err1 = {instancePath,schemaPath:"#/allOf/0/if",keyword:"if",params:{failingKeyword: "then"},message:"must match \"then\" schema"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
}
const _errs8 = errors;
let valid4 = true;
const _errs9 = errors;
if(data && typeof data == "object" && !Array.isArray(data)){
if(data.kind !== undefined){
if("review_result" !== data.kind){
const err2 = {};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
}
}
var _valid1 = _errs9 === errors;
errors = _errs8;
if(vErrors !== null){
if(_errs8){
vErrors.length = _errs8;
}
else {
vErrors = null;
}
}
if(_valid1){
const _errs11 = errors;
if(data && typeof data == "object" && !Array.isArray(data)){
if(data.in_reply_to === undefined){
const err3 = {instancePath,schemaPath:"#/allOf/1/then/required",keyword:"required",params:{missingProperty: "in_reply_to"},message:"must have required property '"+"in_reply_to"+"'"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
if(data.in_reply_to !== undefined){
let data3 = data.in_reply_to;
if(typeof data3 === "string"){
if(func2(data3) < 1){
const err4 = {instancePath:instancePath+"/in_reply_to",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
if(!pattern0.test(data3)){
const err5 = {instancePath:instancePath+"/in_reply_to",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
}
else {
const err6 = {instancePath:instancePath+"/in_reply_to",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
}
}
if(data.payload !== undefined){
if(!(validate19(data.payload, {instancePath:instancePath+"/payload",parentData:data,parentDataProperty:"payload",rootData}))){
vErrors = vErrors === null ? validate19.errors : vErrors.concat(validate19.errors);
errors = vErrors.length;
}
}
}
var _valid1 = _errs11 === errors;
valid4 = _valid1;
}
if(!valid4){
const err7 = {instancePath,schemaPath:"#/allOf/1/if",keyword:"if",params:{failingKeyword: "then"},message:"must match \"then\" schema"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
const _errs17 = errors;
let valid8 = true;
const _errs18 = errors;
if(data && typeof data == "object" && !Array.isArray(data)){
if(data.kind !== undefined){
if("status_report" !== data.kind){
const err8 = {};
if(vErrors === null){
vErrors = [err8];
}
else {
vErrors.push(err8);
}
errors++;
}
}
}
var _valid2 = _errs18 === errors;
errors = _errs17;
if(vErrors !== null){
if(_errs17){
vErrors.length = _errs17;
}
else {
vErrors = null;
}
}
if(_valid2){
const _errs20 = errors;
if(data && typeof data == "object" && !Array.isArray(data)){
if(data.payload !== undefined){
if(!(validate25(data.payload, {instancePath:instancePath+"/payload",parentData:data,parentDataProperty:"payload",rootData}))){
vErrors = vErrors === null ? validate25.errors : vErrors.concat(validate25.errors);
errors = vErrors.length;
}
}
}
var _valid2 = _errs20 === errors;
valid8 = _valid2;
}
if(!valid8){
const err9 = {instancePath,schemaPath:"#/allOf/2/if",keyword:"if",params:{failingKeyword: "then"},message:"must match \"then\" schema"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
}
const _errs23 = errors;
let valid11 = true;
const _errs24 = errors;
if(data && typeof data == "object" && !Array.isArray(data)){
if(data.kind !== undefined){
if("task_request" !== data.kind){
const err10 = {};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
}
}
var _valid3 = _errs24 === errors;
errors = _errs23;
if(vErrors !== null){
if(_errs23){
vErrors.length = _errs23;
}
else {
vErrors = null;
}
}
if(_valid3){
const _errs26 = errors;
if(data && typeof data == "object" && !Array.isArray(data)){
if(data.payload !== undefined){
if(!(validate37(data.payload, {instancePath:instancePath+"/payload",parentData:data,parentDataProperty:"payload",rootData}))){
vErrors = vErrors === null ? validate37.errors : vErrors.concat(validate37.errors);
errors = vErrors.length;
}
}
}
var _valid3 = _errs26 === errors;
valid11 = _valid3;
}
if(!valid11){
const err11 = {instancePath,schemaPath:"#/allOf/3/if",keyword:"if",params:{failingKeyword: "then"},message:"must match \"then\" schema"};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
}
const _errs29 = errors;
let valid14 = true;
const _errs30 = errors;
if(data && typeof data == "object" && !Array.isArray(data)){
if(data.kind !== undefined){
if("completion_report" !== data.kind){
const err12 = {};
if(vErrors === null){
vErrors = [err12];
}
else {
vErrors.push(err12);
}
errors++;
}
}
}
var _valid4 = _errs30 === errors;
errors = _errs29;
if(vErrors !== null){
if(_errs29){
vErrors.length = _errs29;
}
else {
vErrors = null;
}
}
if(_valid4){
const _errs32 = errors;
if(data && typeof data == "object" && !Array.isArray(data)){
if(data.in_reply_to === undefined){
const err13 = {instancePath,schemaPath:"#/allOf/4/then/required",keyword:"required",params:{missingProperty: "in_reply_to"},message:"must have required property '"+"in_reply_to"+"'"};
if(vErrors === null){
vErrors = [err13];
}
else {
vErrors.push(err13);
}
errors++;
}
if(data.payload !== undefined){
if(!(validate41(data.payload, {instancePath:instancePath+"/payload",parentData:data,parentDataProperty:"payload",rootData}))){
vErrors = vErrors === null ? validate41.errors : vErrors.concat(validate41.errors);
errors = vErrors.length;
}
}
if(data.in_reply_to !== undefined){
let data11 = data.in_reply_to;
if(typeof data11 === "string"){
if(func2(data11) < 1){
const err14 = {instancePath:instancePath+"/in_reply_to",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err14];
}
else {
vErrors.push(err14);
}
errors++;
}
if(!pattern0.test(data11)){
const err15 = {instancePath:instancePath+"/in_reply_to",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err15];
}
else {
vErrors.push(err15);
}
errors++;
}
}
else {
const err16 = {instancePath:instancePath+"/in_reply_to",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err16];
}
else {
vErrors.push(err16);
}
errors++;
}
}
}
var _valid4 = _errs32 === errors;
valid14 = _valid4;
}
if(!valid14){
const err17 = {instancePath,schemaPath:"#/allOf/4/if",keyword:"if",params:{failingKeyword: "then"},message:"must match \"then\" schema"};
if(vErrors === null){
vErrors = [err17];
}
else {
vErrors.push(err17);
}
errors++;
}
const _errs38 = errors;
let valid18 = true;
const _errs39 = errors;
if(data && typeof data == "object" && !Array.isArray(data)){
if(data.kind !== undefined){
if("interruption_report" !== data.kind){
const err18 = {};
if(vErrors === null){
vErrors = [err18];
}
else {
vErrors.push(err18);
}
errors++;
}
}
}
var _valid5 = _errs39 === errors;
errors = _errs38;
if(vErrors !== null){
if(_errs38){
vErrors.length = _errs38;
}
else {
vErrors = null;
}
}
if(_valid5){
const _errs41 = errors;
if(data && typeof data == "object" && !Array.isArray(data)){
if(data.in_reply_to === undefined){
const err19 = {instancePath,schemaPath:"#/allOf/5/then/required",keyword:"required",params:{missingProperty: "in_reply_to"},message:"must have required property '"+"in_reply_to"+"'"};
if(vErrors === null){
vErrors = [err19];
}
else {
vErrors.push(err19);
}
errors++;
}
if(data.payload !== undefined){
if(!(validate51(data.payload, {instancePath:instancePath+"/payload",parentData:data,parentDataProperty:"payload",rootData}))){
vErrors = vErrors === null ? validate51.errors : vErrors.concat(validate51.errors);
errors = vErrors.length;
}
}
if(data.in_reply_to !== undefined){
let data14 = data.in_reply_to;
if(typeof data14 === "string"){
if(func2(data14) < 1){
const err20 = {instancePath:instancePath+"/in_reply_to",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err20];
}
else {
vErrors.push(err20);
}
errors++;
}
if(!pattern0.test(data14)){
const err21 = {instancePath:instancePath+"/in_reply_to",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err21];
}
else {
vErrors.push(err21);
}
errors++;
}
}
else {
const err22 = {instancePath:instancePath+"/in_reply_to",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err22];
}
else {
vErrors.push(err22);
}
errors++;
}
}
}
var _valid5 = _errs41 === errors;
valid18 = _valid5;
}
if(!valid18){
const err23 = {instancePath,schemaPath:"#/allOf/5/if",keyword:"if",params:{failingKeyword: "then"},message:"must match \"then\" schema"};
if(vErrors === null){
vErrors = [err23];
}
else {
vErrors.push(err23);
}
errors++;
}
if(data && typeof data == "object" && !Array.isArray(data)){
if(data.schema_version === undefined){
const err24 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "schema_version"},message:"must have required property '"+"schema_version"+"'"};
if(vErrors === null){
vErrors = [err24];
}
else {
vErrors.push(err24);
}
errors++;
}
if(data.kind === undefined){
const err25 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "kind"},message:"must have required property '"+"kind"+"'"};
if(vErrors === null){
vErrors = [err25];
}
else {
vErrors.push(err25);
}
errors++;
}
if(data.id === undefined){
const err26 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "id"},message:"must have required property '"+"id"+"'"};
if(vErrors === null){
vErrors = [err26];
}
else {
vErrors.push(err26);
}
errors++;
}
if(data.issued_at === undefined){
const err27 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "issued_at"},message:"must have required property '"+"issued_at"+"'"};
if(vErrors === null){
vErrors = [err27];
}
else {
vErrors.push(err27);
}
errors++;
}
if(data.issuer === undefined){
const err28 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "issuer"},message:"must have required property '"+"issuer"+"'"};
if(vErrors === null){
vErrors = [err28];
}
else {
vErrors.push(err28);
}
errors++;
}
if(data.subject === undefined){
const err29 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "subject"},message:"must have required property '"+"subject"+"'"};
if(vErrors === null){
vErrors = [err29];
}
else {
vErrors.push(err29);
}
errors++;
}
if(data.payload === undefined){
const err30 = {instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: "payload"},message:"must have required property '"+"payload"+"'"};
if(vErrors === null){
vErrors = [err30];
}
else {
vErrors.push(err30);
}
errors++;
}
for(const key0 in data){
if(!((((((((key0 === "schema_version") || (key0 === "kind")) || (key0 === "id")) || (key0 === "issued_at")) || (key0 === "in_reply_to")) || (key0 === "issuer")) || (key0 === "subject")) || (key0 === "payload"))){
const err31 = {instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err31];
}
else {
vErrors.push(err31);
}
errors++;
}
}
if(data.schema_version !== undefined){
if(1 !== data.schema_version){
const err32 = {instancePath:instancePath+"/schema_version",schemaPath:"#/properties/schema_version/const",keyword:"const",params:{allowedValue: 1},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err32];
}
else {
vErrors.push(err32);
}
errors++;
}
}
if(data.kind !== undefined){
let data16 = data.kind;
if(typeof data16 !== "string"){
const err33 = {instancePath:instancePath+"/kind",schemaPath:"#/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err33];
}
else {
vErrors.push(err33);
}
errors++;
}
if(!((((((data16 === "review_request") || (data16 === "review_result")) || (data16 === "status_report")) || (data16 === "task_request")) || (data16 === "completion_report")) || (data16 === "interruption_report"))){
const err34 = {instancePath:instancePath+"/kind",schemaPath:"#/properties/kind/enum",keyword:"enum",params:{allowedValues: schema11.properties.kind.enum},message:"must be equal to one of the allowed values"};
if(vErrors === null){
vErrors = [err34];
}
else {
vErrors.push(err34);
}
errors++;
}
}
if(data.id !== undefined){
let data17 = data.id;
if(typeof data17 === "string"){
if(func2(data17) < 1){
const err35 = {instancePath:instancePath+"/id",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err35];
}
else {
vErrors.push(err35);
}
errors++;
}
if(!pattern0.test(data17)){
const err36 = {instancePath:instancePath+"/id",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err36];
}
else {
vErrors.push(err36);
}
errors++;
}
}
else {
const err37 = {instancePath:instancePath+"/id",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err37];
}
else {
vErrors.push(err37);
}
errors++;
}
}
if(data.issued_at !== undefined){
let data18 = data.issued_at;
if(typeof data18 === "string"){
if(!(formats0.validate(data18))){
const err38 = {instancePath:instancePath+"/issued_at",schemaPath:"#/definitions/timestamp/format",keyword:"format",params:{format: "date-time"},message:"must match format \""+"date-time"+"\""};
if(vErrors === null){
vErrors = [err38];
}
else {
vErrors.push(err38);
}
errors++;
}
}
else {
const err39 = {instancePath:instancePath+"/issued_at",schemaPath:"#/definitions/timestamp/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err39];
}
else {
vErrors.push(err39);
}
errors++;
}
}
if(data.in_reply_to !== undefined){
let data19 = data.in_reply_to;
if(typeof data19 === "string"){
if(func2(data19) < 1){
const err40 = {instancePath:instancePath+"/in_reply_to",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err40];
}
else {
vErrors.push(err40);
}
errors++;
}
if(!pattern0.test(data19)){
const err41 = {instancePath:instancePath+"/in_reply_to",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err41];
}
else {
vErrors.push(err41);
}
errors++;
}
}
else {
const err42 = {instancePath:instancePath+"/in_reply_to",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err42];
}
else {
vErrors.push(err42);
}
errors++;
}
}
if(data.issuer !== undefined){
let data20 = data.issuer;
if(data20 && typeof data20 == "object" && !Array.isArray(data20)){
if(data20.session_id === undefined){
const err43 = {instancePath:instancePath+"/issuer",schemaPath:"#/properties/issuer/required",keyword:"required",params:{missingProperty: "session_id"},message:"must have required property '"+"session_id"+"'"};
if(vErrors === null){
vErrors = [err43];
}
else {
vErrors.push(err43);
}
errors++;
}
for(const key1 in data20){
if(!(key1 === "session_id")){
const err44 = {instancePath:instancePath+"/issuer",schemaPath:"#/properties/issuer/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err44];
}
else {
vErrors.push(err44);
}
errors++;
}
}
if(data20.session_id !== undefined){
let data21 = data20.session_id;
if(typeof data21 === "string"){
if(func2(data21) < 1){
const err45 = {instancePath:instancePath+"/issuer/session_id",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err45];
}
else {
vErrors.push(err45);
}
errors++;
}
if(!pattern0.test(data21)){
const err46 = {instancePath:instancePath+"/issuer/session_id",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err46];
}
else {
vErrors.push(err46);
}
errors++;
}
}
else {
const err47 = {instancePath:instancePath+"/issuer/session_id",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err47];
}
else {
vErrors.push(err47);
}
errors++;
}
}
}
else {
const err48 = {instancePath:instancePath+"/issuer",schemaPath:"#/properties/issuer/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err48];
}
else {
vErrors.push(err48);
}
errors++;
}
}
if(data.subject !== undefined){
let data22 = data.subject;
if(data22 && typeof data22 == "object" && !Array.isArray(data22)){
if(data22.worktree_id === undefined){
const err49 = {instancePath:instancePath+"/subject",schemaPath:"#/properties/subject/required",keyword:"required",params:{missingProperty: "worktree_id"},message:"must have required property '"+"worktree_id"+"'"};
if(vErrors === null){
vErrors = [err49];
}
else {
vErrors.push(err49);
}
errors++;
}
for(const key2 in data22){
if(!(((key2 === "worktree_id") || (key2 === "commit")) || (key2 === "implementation_session_id"))){
const err50 = {instancePath:instancePath+"/subject",schemaPath:"#/properties/subject/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err50];
}
else {
vErrors.push(err50);
}
errors++;
}
}
if(data22.worktree_id !== undefined){
let data23 = data22.worktree_id;
if(typeof data23 === "string"){
if(func2(data23) < 1){
const err51 = {instancePath:instancePath+"/subject/worktree_id",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err51];
}
else {
vErrors.push(err51);
}
errors++;
}
if(!pattern0.test(data23)){
const err52 = {instancePath:instancePath+"/subject/worktree_id",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err52];
}
else {
vErrors.push(err52);
}
errors++;
}
}
else {
const err53 = {instancePath:instancePath+"/subject/worktree_id",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err53];
}
else {
vErrors.push(err53);
}
errors++;
}
}
if(data22.commit !== undefined){
let data24 = data22.commit;
if(typeof data24 === "string"){
if(!pattern13.test(data24)){
const err54 = {instancePath:instancePath+"/subject/commit",schemaPath:"#/definitions/commit/pattern",keyword:"pattern",params:{pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$"},message:"must match pattern \""+"^(?:[a-f0-9]{40}|[a-f0-9]{64})$"+"\""};
if(vErrors === null){
vErrors = [err54];
}
else {
vErrors.push(err54);
}
errors++;
}
}
else {
const err55 = {instancePath:instancePath+"/subject/commit",schemaPath:"#/definitions/commit/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err55];
}
else {
vErrors.push(err55);
}
errors++;
}
}
if(data22.implementation_session_id !== undefined){
let data25 = data22.implementation_session_id;
if(typeof data25 === "string"){
if(func2(data25) < 1){
const err56 = {instancePath:instancePath+"/subject/implementation_session_id",schemaPath:"#/definitions/text/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"};
if(vErrors === null){
vErrors = [err56];
}
else {
vErrors.push(err56);
}
errors++;
}
if(!pattern0.test(data25)){
const err57 = {instancePath:instancePath+"/subject/implementation_session_id",schemaPath:"#/definitions/text/pattern",keyword:"pattern",params:{pattern: "\\S"},message:"must match pattern \""+"\\S"+"\""};
if(vErrors === null){
vErrors = [err57];
}
else {
vErrors.push(err57);
}
errors++;
}
}
else {
const err58 = {instancePath:instancePath+"/subject/implementation_session_id",schemaPath:"#/definitions/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err58];
}
else {
vErrors.push(err58);
}
errors++;
}
}
}
else {
const err59 = {instancePath:instancePath+"/subject",schemaPath:"#/properties/subject/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err59];
}
else {
vErrors.push(err59);
}
errors++;
}
}
if(data.payload !== undefined){
let data26 = data.payload;
if(!(data26 && typeof data26 == "object" && !Array.isArray(data26))){
const err60 = {instancePath:instancePath+"/payload",schemaPath:"#/properties/payload/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err60];
}
else {
vErrors.push(err60);
}
errors++;
}
}
}
else {
const err61 = {instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err61];
}
else {
vErrors.push(err61);
}
errors++;
}
validate10.errors = vErrors;
return errors === 0;
}
