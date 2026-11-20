type Segment={kind:'code'|'quoted'|'comment';start:number;end:number};
function segments(source:string):Segment[]{
  const result:Segment[]=[];let index=0,codeStart=0;
  const push=(kind:Segment['kind'],start:number,end:number)=>{if(end>start)result.push({kind,start,end});};
  while(index<source.length){
    const start=index,char=source[index],next=source[index+1];
    if(char==='-'&&next==='-'){
      push('code',codeStart,index);index+=2;while(index<source.length&&source[index]!=='\n')index++;push('comment',start,index);codeStart=index;continue;
    }
    if(char==='/'&&next==='*'){
      push('code',codeStart,index);index+=2;let depth=1;
      while(index<source.length&&depth){if(source[index]==='/'&&source[index+1]==='*'){depth++;index+=2;}else if(source[index]==='*'&&source[index+1]==='/'){depth--;index+=2;}else index++;}
      if(depth)throw new TypeError('Unterminated SQL block comment.');push('comment',start,index);codeStart=index;continue;
    }
    const dollar=char==='$'?source.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0]:undefined;
    if(dollar){
      push('code',codeStart,index);const end=source.indexOf(dollar,index+dollar.length);if(end<0)throw new TypeError('Unterminated SQL dollar-quoted body.');index=end+dollar.length;push('quoted',start,index);codeStart=index;continue;
    }
    if(char==="'"||char==='"'){
      push('code',codeStart,index);const escaped=char==="'"&&/[eE]/.test(source[index-1]||'')&&!/[A-Za-z0-9_]/.test(source[index-2]||'');index++;let closed=false;
      while(index<source.length){if(escaped&&source[index]==='\\'){index+=2;continue;}if(source[index]===char){if(source[index+1]===char){index+=2;continue;}index++;closed=true;break;}index++;}
      if(!closed)throw new TypeError('Unterminated SQL quoted value.');push('quoted',start,index);codeStart=index;continue;
    }
    index++;
  }
  push('code',codeStart,source.length);return result;
}
/** Split reviewed PostgreSQL source without breaking PL/pgSQL, literals or comments. */
export function splitSql(source:string):string[]{
  if(typeof source!=='string')throw new TypeError('Invalid SQL source.');
  const result:string[]=[];let start=0,hasCode=false;
  for(const segment of segments(source)){
    if(segment.kind==='quoted'){hasCode=true;continue;}
    if(segment.kind==='comment')continue;
    for(let index=segment.start;index<segment.end;index++){
      if(source[index]===';'){if(hasCode)result.push(source.slice(start,index).trim());start=index+1;hasCode=false;}
      else if(!/\s/.test(source[index]))hasCode=true;
    }
  }
  if(hasCode)result.push(source.slice(start).trim());return result;
}
export function bindPostgresParameters(source:string,parameters:Record<string,unknown>={}){
  if(!parameters||typeof parameters!=='object'||Array.isArray(parameters)||Object.keys(parameters).some(key=>!/^[a-z][a-z0-9_]*$/.test(key)))throw new TypeError('Invalid database parameter name.');
  const values:unknown[]=[],positions=new Map<string,number>();let sql='';
  for(const segment of segments(source)){
    const text=source.slice(segment.start,segment.end);
    if(segment.kind!=='code'){sql+=text;continue;}
    sql+=text.replace(/(?<!:):([a-z][a-z0-9_]*)/g,(_match,key)=>{
      if(!Object.hasOwn(parameters,key))throw new TypeError('A required database parameter is missing.');
      if(!positions.has(key)){
        const value=parameters[key];
        if(typeof value==='number'&&(!Number.isFinite(value)||(Number.isInteger(value)&&!Number.isSafeInteger(value))))throw new TypeError('Invalid database parameter number.');
        if(value!==null&&value!==undefined&&!['string','number','boolean','object'].includes(typeof value))throw new TypeError('Invalid database parameter value.');
        values.push(value!==null&&typeof value==='object'?JSON.stringify(value):value??null);positions.set(key,values.length);
      }
      return'$'+positions.get(key);
    });
  }
  return{sql,values};
}
