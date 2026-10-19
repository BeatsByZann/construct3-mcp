"use strict";
const reg = {
  cond: (def) => def,
  act: (def) => def,
  expr: (def) => def,
};

function registerCommon(c, a, e) {
  c({id:"compare-instance-variable",c2id:"compare-instance-variable",scriptName:'CompareInstanceVar',isTrigger:!1,params:[{id:"instance-variable",type:"instancevar"},{id:"comparison",type:"cmp"},{id:"value",type:"any"}]});
  a({id:"set-instvar-value",c2id:"set-instvar-value",scriptName:"SetInstanceVar",highlighted:!0,params:[{id:"instance-variable",type:"instancevar"},{id:"value",type:"any"}]});
  a({scriptName:"SetX",id:"set-x",isAsync:!1,params:[{id:"x",type:"number"}]});
  a({id:"set-position",scriptName:"SetPosition",params:[{id:"x",type:"number"},{id:"y",type:"number"}]});
  e({id:"uid",expressionName:"UID",returnType:"number"});
  a({title:"not a registration",extra:{id:"nested-only",scriptName:"Nested"}});
}
