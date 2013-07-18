/*
 * Based on https://raw.github.com/zaach/floop.js/master/lib/lljsgen.js @ 4a981a2799
 */

"use strict";

function id(identifier) {
  return identifier.split('-').join('_').replace('?', '$');
}

function isNode() {
  return typeof process === 'object' && typeof require === 'function';
}

function SymbolTable() {
  var data = [{}],
      name_cnt = 0;

  function begin_scope() {
    data.push({});
  }
  function end_scope() {
    if (data.length === 1) {
      throw new Error("end_scope without begin_scope");
    }
    data.pop();
  }

  function indexOf(name) {
    for(var idx = data.length-1; idx >= 0; idx--) {
      if (data[idx][name]) {
        return idx;
      }
    }
    return undefined;
  }

  function lookup(name) {
    var name = name.toUpperCase(),
        idx = indexOf(name);
    if (typeof(idx) !== "undefined") {
      return data[idx][name];
    }
    throw new Error("Name '" + name + "' not found in symbol table");
  }

  function insert(name, value, level) {
    if (typeof level === 'undefined') { level = data.length-1; }
    data[level][name.toUpperCase()] = value;
  }

  // insert a definition for unit procedure/function
  function unit_pinsert(name, evalfn, fparams, rettype) {
    var kind = rettype ? 'func' : 'proc',
        decl = {node:kind + '_decl',name:name,evalfn:evalfn,level:0,
                type:rettype,lparams:[],fparams:[]};
    for (var i=0; i < fparams.length; i++) {
      var fparam = fparams[i];
      fparam.node = 'param';
      fparam.id = "param" + i;
      decl.fparams.push(fparam);
    }
    insert(name,decl);
  }

  function replace(name, value) {
    var name = name.toUpperCase(),
        idx = indexOf(name);
    if (typeof(idx) !== "undefined") {
      data[idx][name] = value;
    } else {
      throw new Error("Name '" + name + "' not found to replace");
    }
  }

  function new_name(name) {
    return name + "_" + (name_cnt++) + "_";
  }

  function display() {
    console.warn("-------------");
    for(var idx = 0; idx < data.length; idx++) {
      console.warn("--- " + idx + " ---");
      for(var name in data[idx]) {
        console.warn(name + ": ", data[idx][name]);
      }
    }
    console.warn("-------------");
  }

  return {lookup: lookup,
          insert: insert,
          unit_pinsert: unit_pinsert,
          replace: replace,
          begin_scope: begin_scope,
          end_scope: end_scope,
          new_name: new_name,
          display: display};
};

function IR(theAST) {

  var st = new SymbolTable(),
      str_cnt = 0,
      default_units = ['SYSTEM'];

  // Store global settings in the symbol table
  st.insert('_settings_', {});

  function load_unit(unit) {
    var lib = null,
        unit_path = './units/' + unit.toLowerCase() + ".js",
        unit_name = unit.toUpperCase();
    if (isNode()) {
      // Node.js
      var rlib = require(unit_path),
      lib = new rlib[unit_name](st);
    } else if (typeof window[unit_name] !== 'undefined') {
      // Browser - already loaded
      console.log("unit_name: " + unit_name);
      lib = new window[unit_name](st);
    } else {
      // Browser - Synchronous AJAX request
      var xhr = new XMLHttpRequest();
      xhr.open('GET', unit_path, false);
      xhr.send(null);
      lib = new (eval(xhr.responseText))(st);
    }
    return lib;
  }

  function expand_type(type) {
    var t = type;
    while (t.name === 'NAMED' ||
        (t.name === 'ENUMERATION' && t.id)) {
      var tdecl = st.lookup(t.id);
      t = tdecl.type;
    }
    // TODO: simplify/clean this up
    if (t.name === 'SUBRANGE') {
      var node = t.start.node;
      if (node === 'integer') {
        t.name = 'INTEGER';
      } else if (node === 'character') {
        t.name = 'CHARACTER';
      } else {
        var tdecl = st.lookup(t.start.id);
        t = tdecl.type;
        t.itype = type;
      }
    }
    return t;
  }

  // Resolve a type definition to add lltype containing LLVM type
  // string. If the type is a named type then it will be resolved to
  // a base type first.
  function annotate_type(type) {
    var t = expand_type(type),
        lltype, vdef = "0",
        keys = ['type', 'lltype', 'default_value', 'index'];
    switch (t.name) {
      case 'INTEGER':   lltype = "i32";   vdef = "0"; break;
      case 'REAL':      lltype = "float"; vdef = "0.0"; break;
      case 'BOOLEAN':   lltype = "i1";    vdef = "0"; break;
      case 'CHARACTER': lltype = "i8";    vdef = "0"; break;
      case 'STRING':
        annotate_type(t.type);
        lltype = "i8*";
        vdef = "null";
        break;
      case 'ARRAY':
        var index = t.index,
            start = index.start.val,
            end = index.end.val,
            vdefs = [],
            ttype = annotate_type(t.type);
        lltype = '[' + (end-start+1) + ' x ' + ttype.lltype + ']';
        for (var i=0; i < end-start+1; i++) {
          vdefs.push(ttype.lltype + ' ' + ttype.default_value);
        }
        vdef = '[' + vdefs.join(', ') + ']';
        break;
      case 'RECORD':
        var comps = [], vdefs = [],
            sections = t.sections;
        t.component_map = {};
        for (var i=0; i<sections.length; i++) {
          var comp = sections[i],
              ttype = annotate_type(comp.type);
          comps.push(ttype.lltype);
          vdefs.push(ttype.lltype + ' ' + ttype.default_value);
          t.component_map[comp.id] = i;
        }
        lltype = "{" + comps.join(", ") + "}";
        vdef = '{' + vdefs.join(', ') + '}';
        keys.push('sections', 'component_map');
        break;
      case 'ENUMERATION':
        lltype = "i32";
        vdef = 0;
        keys.push('ids', 'enum_type', 'enum_var');
        break;
      default: throw new Error("TODO: handle " + t.name + " type");
    }
    t.lltype = lltype;
    t.default_value = vdef;
    // Copy up the type data
    type.name = t.name;
    for (var i=0; i < keys.length; i++) {
      var k = keys[i];
      if (typeof t[k] !== 'undefined' && typeof type[k] === 'undefined') {
          type[k] = t[k];
      }
    }
    return type;
  }

  function isScalar(type) {
    var t = expand_type(type);
    var res = false;
    switch (t.name) {
      case 'INTEGER':   res = true; break;
      case 'REAL':      res = true; break;
      case 'BOOLEAN':   res = true; break;
      case 'CHARACTER': res = true; break;
    }
    return res;
  }

  function isString(type) {
    var t = expand_type(type);
    return (t.name === 'STRING');
  }

  function isScalarOrString(type) {
    return (isScalar(type) || isString(type));
  }

  function deref_name(lvalue) {
    var id = null,
        lv = lvalue,
        cnames = "";
    do {
      if (lv.node === 'expr_record_deref') {
        cnames = "." + lv.component + cnames ;
      } else if (lv.node === 'expr_array_deref') {
        cnames = "_sub" + cnames;
      } else {
        cnames = lv.id + cnames;
      }
      lv = lv.lvalue;
    } while (lv);
    return cnames;
  }

  function allocate_variable(ir,node,id,fname,type,defval) {
    var pdecl = st.lookup(fname),
        level = pdecl.level,
        vtype = annotate_type(type),
        vdef = typeof defval !== 'undefined' ? defval : vtype.default_value;

    if (level === 0) {
      // global scope
      var sname = "@" + st.new_name(id);
      ir.push([sname + ' = private global ' + vtype.lltype + ' ' + vdef]);
    } else {
      // sub-program scope
      var sname = "%" + st.new_name(id + "_stack");
      ir.push('  ' + sname + ' = alloca ' + vtype.lltype);
      ir.push('  store ' + vtype.lltype + ' ' + vdef + ', ' + vtype.lltype + '* ' + sname);
    }

    st.insert(id,{node:node,type:vtype,sname:sname,level:pdecl.level});
    return sname;
  }

  // normalizeIR takes a JSON IR
  function normalizeIR(ir) {
    var prefix = [], body = [];
    body.push("");
    for (var i=0; i < ir.length; i++) {
      if (typeof(ir[i]) === "object") {
        prefix.push.apply(prefix, ir[i]);
      } else {
        body.push(ir[i]);
      }
    }
    return (prefix.concat(body)).join("\n");
  }

  function toIR(astTree, level, fnames) {
    var ast = (typeof astTree === 'undefined') ? theAST : astTree,
        indent = "",
        fname, node,
        ir = [];
    if (! ast) {
      throw new Error("Warning: toIR called with empty/null AST");
    }
    node = ast.node,
    level = level ? level : 0;
    fnames = fnames ? fnames : [];
    fname = fnames[fnames.length-1];
    for (var i=0; i < level; i++) {
      indent = indent + "  ";
    }

    //console.warn("toIR",node,"level:", level, "fnames:", fnames, "ast:", JSON.stringify(ast));

    switch (node) {
      case 'program':
        // Similar to a proc_decl but with declarations and called by
        // @main
        var id = ast.id,
            fparams = ast.fparams,
            block = ast.block;

        block.param_list = [];
        st.insert(id,{name:id,level:level,fparams:fparams,lparams:[]});

        try {
          ir.push.apply(ir, toIR(block,level,fnames.concat([id])));
        } catch(e) {
          // Catch and report errors with line numbers
          console.error(e.toString() + " [line " + (e.lineno+1) + "]");
          throw e;
        }

        ir.push('');
        ir.push('declare i8* @malloc(i64)');
        ir.push('declare i64 @strlen(i8*)');
        ir.push('declare i8* @strncpy(i8*, i8*, i64)');
        ir.push('declare i8* @strncat(i8*, i8*, i64)');
        ir.push('');
        ir.push('define i32 @main() {');
        ir.push('entry:');
        ir.push('  %ret = call i32 @' + id + '()');
        ir.push('  ret i32 0');
        ir.push('}');
        break;

      case 'block':
        var uses = ast.uses,
            decls = ast.decls,
            stmts = ast.stmts,
            pdecl = st.lookup(fname),
            lparams = pdecl.lparams,
            fparams = pdecl.fparams,
            param_list = [],
            lparam_list = [],
            unit_init_ir = [],
            unit_stop_ir = [],
            pdecl_ir = [],
            vdecl_ir = [],
            stmts_ir = [];

        /* Evaluate libraries specified in the 'uses' declaration */
        if (uses) {
          // Loaded by default
          var unit_list = default_units.slice();

          /* user specified */
          for (var i=0; i<uses.length; i++) {
            if (unit_list.indexOf(uses[i]) < 0) {
              unit_list.push(uses[i]);
            }
          }

          for (var i=0; i<unit_list.length; i++) {
            var unit = unit_list[i],
                lib = load_unit(unit);
            unit_init_ir.push.apply(unit_init_ir, lib.init());
            unit_stop_ir.push.apply(unit_stop_ir, lib.stop());
          }
        }

        // Regular formal parameters
        for (var i=0; i < fparams.length; i++) {
          var fparam = fparams[i],
              ftype = annotate_type(fparam.type),
              lltype = ftype.lltype,
              pname = "%" + st.new_name(fparam.id + "_fparam"),
              sname = "%" + st.new_name(fparam.id + "_fparam_stack");
          if (fparam.var) {
            vdecl_ir.push('  ' + pname + ' = load ' + lltype + '* ' + sname);
            param_list.push(lltype + '* ' + sname);
          } else {
            vdecl_ir.push('  ' + sname + ' = alloca ' + lltype);
            vdecl_ir.push('  store ' + lltype + ' ' + pname + ', ' + lltype + '* ' + sname);
            param_list.push(lltype + ' ' + pname);
          }
          st.insert(fparam.id,{node:'var_decl',type:ftype,pname:pname,sname:sname,var:fparam.var,level:level});
        }

        // Evaluate the children. We might need to modify the
        // param-list based on internal variables that refer to higher
        // level lexical scope
        var curAst = null;
        try {
          for (var i=0; i < decls.length; i++) {
            var decl = decls[i];
            curAst = decl;
            if (decl.node === 'proc_decl' || decl.node === 'func_decl') {
              pdecl_ir.push.apply(pdecl_ir, toIR(decl,level,fnames));
            } else {
              vdecl_ir.push.apply(vdecl_ir, toIR(decl,level,fnames));
            }
          }
          for (var i=0; i < stmts.length; i++) {
            curAst = stmts[i];
            stmts_ir.push.apply(stmts_ir, toIR(stmts[i],level,fnames));
          }
        } catch (e) {
          // Add the line number to the exception but only if it's not
          // already set, otherwise we would stomp a more specific
          // line number
          if (typeof e.lineno === 'undefined') {
            e.lineno = curAst.lineno;
          }
          throw e;
        }

        // Variables that refer to higher lexical scope
        for (var i=0; i < lparams.length; i++) {
          var lparam = lparams[i],
              ldecl = st.lookup(lparam.id),
              sname = ldecl.sname,
              ltype = annotate_type(ldecl.type),
              lltype = ltype.lltype;
            lparam_list.push(lltype + '* ' + sname);
        }
        param_list = lparam_list.concat(param_list);

        // Now output the IR
        // Add sub-program declarations at the top level
        var pitype = pdecl.itype || "i32";
        ir.push.apply(ir, pdecl_ir);
        ir.push('');
        ir.push('define ' + pitype + ' @' + pdecl.name + '(' + param_list.join(", ") +') {');
        ir.push('entry:');
        ir.push.apply(ir, unit_init_ir);
        // For functions, add the return parameter
        if (pdecl.ireturn) {
          ir.push('  %retval = alloca ' + pitype);
        }
        // Add variable declarations inside the body definition
        ir.push.apply(ir, vdecl_ir);
        // Postpone variable declarations until inside the body
        ir.push.apply(ir, stmts_ir);
        if (pdecl.ireturn) {
          ir.push('  %retreg = load ' + pitype + '* %retval');
          ir.push('  ret ' + pitype + ' %retreg');
        } else {
          ir.push('  ret ' + pitype + ' 0');
        }
        ir.push.apply(ir, unit_stop_ir);
        ir.push('}');
        break;

      case 'type_decl':
        var id = ast.id,
            type = ast.type;
        if (type.name === 'NAMED') {
          st.lookup(type.id); // verify the reference type exists
        }
        if (type.name === 'ENUMERATION') {
          var ecnt = type.ids.length,
              enum_type = '[' + ecnt + ' x i8*]',
              enum_name = st.new_name(id),
              enum_var = '@enum.' + enum_name,
              vlist = [];
          type.enum_type = enum_type;
          type.enum_var = enum_var;
          for (var i=0; i < ecnt; i++) {
            var eid = type.ids[i],
                eidstr = '@str.' + enum_name + '.' + eid,
                elen = eid.length + 1,
                eitype = '[' + elen + ' x i8]',
                estr = 'c"' + eid + '\\00"';
            vlist.push('i8* getelementptr inbounds (' + eitype + '* ' + eidstr + ', i32 0, i32 0)');
            ir.push([eidstr + ' = private unnamed_addr constant ' + eitype + ' ' + estr]);
            // Each enumeration element is a var declaration
            allocate_variable(ir,'var_decl',eid.toUpperCase(),fname,type,i);
          }
          // Declare the array of strings for the enum values so that
          // we can print them out if needed
          ir.push([enum_var + ' = global ' + enum_type + ' [ ' + vlist.join(", ") + ' ]']);
        }
        st.insert(id,{node:'type_decl',id:id,type:type});
        break;

      case 'var_decl':
        var sname = allocate_variable(ir,'var_decl',ast.id,fname,ast.type);
        break;

      case 'const_decl':
        var id = ast.id,
            expr = ast.expr;

        ir.push.apply(ir, toIR(expr,level,fnames));

        var sname = allocate_variable(ir,'const_decl',id,fname,expr.type);

        ir.push('  store ' + expr.itype + ' ' + expr.ilocal + ', ' + expr.itype + '* ' + sname);
        break;

      case 'proc_decl':
      case 'func_decl':
        var id = ast.id,
            type = ast.type,
            fparams = ast.fparams,
            block = ast.block,
            new_level = level+1;

        st.insert(id, {name: id, type:type, level: new_level,fparams:fparams,lparams:[]});
        st.begin_scope();
        ir.push.apply(ir, toIR(block,new_level,fnames.concat([id])));
        st.end_scope();
        break;

      case 'stmt_assign':
        var lvalue = ast.lvalue,
            expr = ast.expr;
        ir.push('  ; ASSIGN start');
        ir.push.apply(ir,toIR(expr,level,fnames));
        var litype = null, listack = null;

        if (lvalue.id === fname) {
          // This is actually a function name being used to set the
          // return value for the function so we don't evaluate the
          // lvalue
          var pdecl = st.lookup(fname);
          ptype = annotate_type(pdecl.type);
          lvalue.type = pdecl.type;
          lvalue.itype = ptype.lltype;
          pdecl.ireturn = true;
          pdecl.itype = lvalue.itype;
          st.replace(fname,pdecl);
          litype = lvalue.itype;
          listack = "%retval";
        } else {
          ir.push.apply(ir,toIR(lvalue,level,fnames));
          litype = lvalue.itype;
          listack = lvalue.istack;
        }

        if (lvalue.type.name === 'STRING' && expr.type.name === 'STRING' && expr.val) {
          // string literal being assigned to string variable
          ir.push('  store i8* getelementptr inbounds (' + expr.itype + ' ' + expr.istack + ', i32 0, i32 0), ' + litype + '* ' + listack);
        } else if (lvalue.type.name === 'STRING' && expr.type.name === 'STRING') {
          // string being assigned to string so malloc and copy
          var slen1 = '%' + st.new_name('slen'),
              slen2 = '%' + st.new_name('slen'),
              lvar = '%' + st.new_name('lvar'),
              decay1 = '%' + st.new_name('arraydecay'),
              decay2 = '%' + st.new_name('arraydecay'),
              chr = '%' + st.new_name('chr'),
              res = '%' + st.new_name('res');
          ir.push('  ' + slen1 + ' = call i64 @strlen(i8* ' + expr.ilocal + ')');
          ir.push('  ' + slen2 + ' = add i64 1, ' + slen1);
          ir.push('  ' + lvar + ' = call i8* @malloc(i64 ' + slen2 + ')');
          ir.push('  store i8* ' + lvar + ', ' + litype + '* ' + listack);
          ir.push('  ' + res + ' = call i8* @strncpy(i8* ' + lvar + ', i8* ' + expr.ilocal + ', i64 ' + slen2 + ')');
        } else if (lvalue.type.name === 'REAL' && expr.type.name === 'INTEGER') {
          // coerce integer to real
          var conv = st.new_name("%conv");
          ir.push('  ' + conv + ' = sitofp i32 ' + expr.ilocal + ' to float');
          ir.push('  store float ' + conv + ', ' + litype + '* ' + listack);
        } else if (lvalue.type.name !== expr.type.name) {
          throw new Error("Type of lvalue and expression do not match: " + lvalue.type.name + " vs " + expr.type.name);
        } else {
          ir.push('  store ' + expr.itype + ' ' + expr.ilocal + ', ' + litype + '* ' + listack);
        }
        
        ast.itype = litype;
        ast.istack = listack;
        ast.ilocal = expr.ilocal;
        ir.push('  ; ASSIGN finish');
        break;

      case 'stmt_call':
      case 'expr_call':
        var id = ast.id, pdecl;
        try {
          pdecl = st.lookup(id);
        } catch (e) {
          throw new Error("Unknown function '" + id + "'");
        }
        var lparams = pdecl.lparams,
            fparams = pdecl.fparams,
            cparams = (ast.call_params || []);
        // evaluate the parameters
        for(var i=0; i < cparams.length; i++) {
          ir.push.apply(ir, toIR(cparams[i],level,fnames));
        }
        // Check that call params and formal params match length and
        // types
        if (fparams.length === 0 && cparams.length !== 0) {
          throw new Error("Parameter mismatch calling " + id + ": " +
                          "parameter(s) given but none defined");
        }
        for(var i=0; i < fparams.length; i++) {
          var cparam = cparams[i],
              fparam = fparams[i],
              ftype = fparam.type.name;
          if (ftype === 'varargs') {
            // We've checked as far as we can go on this side.
            // 'varargs' only applies to built-in unit routines and
            // must be done by the routine evalfn itself
            break;
          }
          if (ftype === 'any') {
            // The routine can accept multiple types in this position
            // so assume we're good and continue to the next argument.
            // 'any' only applies to built-in unit routines and
            // checking must be done by the routine evalfn itself
            continue;
          }
          if (!cparam) {
            throw new Error("Parameter mismatch calling " +
                            id + ": more than " + i +
                            " parameter(s) required but " + i +
                            " given")
          }
          var cname = cparam.id ? cparam.id : "'" + cparam.val + "'",
              ctype = cparam.type.name;
          if (ftype === 'multiple') {
            var ftypes = fparam.type.names;
            if (ftypes.indexOf(ctype) < 0) {
              throw new Error("Parameter mismatch calling " +
                              id + ": " + cname + ":" + ctype +
                              " given, but definition is " + ftypes);
            }
          } else {
            if (ctype !== ftype) {
              throw new Error("Parameter mismatch calling " +
                              id + ": " + cname + ":" + ctype +
                              " given, but definition is " + ftype);
            }
          }
        }
        if (pdecl.evalfn) {
          // This is a call to built-in unit routine and needs to be
          // evaluated (in a sense: macro expanded)
          ir.push.apply(ir, pdecl.evalfn(ast, cparams));
        } else {
          var param_list = [];
          for(var i=0; i < lparams.length; i++) {
            var lparam = lparams[i],
                lltype = null;
            ir.push.apply(ir, toIR(lparam,level,fnames));
            ltype = annotate_type(lparam.type),
            param_list.push(ltype.lltype + "* " + lparam.istack);
          }
          for(var i=0; i < cparams.length; i++) {
            var cparam = cparams[i],
                fparam = fparams[i];
            if (cparams[i].lparam) {
              throw new Error("TODO handle lparam in call");
            } else if (fparam.var) {
              param_list.push(cparam.itype + "* " + cparam.istack);
            } else if (fparam.type.name === 'STRING' && cparam.itype[0] === '[') {
              // TODO: above check is ugly, should be better way to distinguish character array from i8* string
              // coerce character array to i8*
              param_list.push('i8* getelementptr inbounds (' + cparam.itype + ' ' + cparam.istack + ', i32 0, i32 0)');
            } else {
              param_list.push(cparam.itype + " " + cparam.ilocal);
            }
          }
          if (node === 'expr_call') {
            var ret = '%' + st.new_name(pdecl.name + "_ret"),
              ptype = annotate_type(pdecl.type),
              lltype = ptype.lltype;
            ir.push('  ' + ret + ' = call ' + lltype + ' @' + pdecl.name + "(" + param_list.join(", ") + ")");
            ast.type = pdecl.type;
            ast.itype = lltype;
            ast.ilocal = ret;
          } else {
            ir.push('  call i32 @' + pdecl.name + "(" + param_list.join(", ") + ")");
          }
        }
        break;

      case 'stmt_compound':
        for (var i=0; i < ast.stmts.length; i++) {
          ir.push.apply(ir,toIR(ast.stmts[i],level,fnames));
        }
        break;

      case 'stmt_if':
        var expr = ast.expr,
            tstmt = ast.tstmt,
            fstmt = ast.fstmt;
        ir.push('');
        ir.push('  ; if statement start');
        ir.push.apply(ir, toIR(expr,level,fnames));
        var br_name = st.new_name('br'),
            br_true = br_name + '_true',
            br_false = br_name + '_false',
            br_done = br_name + '_done';
        ir.push('  br ' + expr.itype + ' ' + expr.ilocal + ', label %' + br_true + ', label %' + br_false);
        ir.push(br_true + ':');
        if (tstmt) {
          ir.push.apply(ir, toIR(tstmt,level,fnames));
        }
        ir.push('  br label %' + br_done); 
        ir.push(br_false + ':');
        if (fstmt) {
          ir.push.apply(ir, toIR(fstmt,level,fnames));
        }
        ir.push('  br label %' + br_done); 
        ir.push(br_done + ':');
        ir.push('  ; if statement finish');
        ir.push('');
        break;

      case 'stmt_for':
        var index = ast.index,
            start = ast.start,
            by = ast.by,
            end = ast.end,
            stmt = ast.stmt,
            for_label = st.new_name('for'),
            for_start = for_label + 'start',
            for_cond = for_label + 'cond',
            for_body = for_label + 'body',
            for_inc = for_label + 'inc',
            for_end = for_label + 'end',
            for_cmp = '%' + for_label + 'cmp',
            for_cmp1 = '%' + for_label + 'cmp1',
            for_cmp2 = '%' + for_label + 'cmp2',
            for_inc1 = '%' + for_label + 'inc1',
            for1 = '%' + for_label + '1',
            for2 = '%' + for_label + '2',
            for3 = '%' + for_label + '3';

        ir.push('');
        ir.push('  ; for statement start');

        ir.push.apply(ir, toIR(index,level,fnames));
        ir.push.apply(ir, toIR(start,level,fnames));
        ir.push.apply(ir, toIR(end,level,fnames));

        if (by === 1) {
          ir.push('  ' + for_cmp + ' = icmp sgt i32 ' + start.ilocal + ', ' + end.ilocal);
        } else {
          ir.push('  ' + for_cmp + ' = icmp slt i32 ' + start.ilocal + ', ' + end.ilocal);
        }
        ir.push('  br i1 ' + for_cmp + ', label %' + for_end + ', label %' + for_start);

        ir.push('  br label %' + for_start); 

        ir.push('');
        ir.push(for_start + ':');
        ir.push('  store ' + start.itype + ' ' + start.ilocal + ', ' + index.itype + '* ' + index.istack);
        ir.push('  br label %' + for_cond); 

        ir.push('');
        ir.push(for_cond + ':');
        ir.push('  ' + for1 + ' = load i32* ' + index.istack);
        if (by === 1) {
          ir.push('  ' + for_cmp1 + ' = icmp sle i32 ' + for1 + ', ' + end.ilocal);
        } else {
          ir.push('  ' + for_cmp1 + ' = icmp sge i32 ' + for1 + ', ' + end.ilocal);
        }
        ir.push('  br i1 ' + for_cmp1 + ', label %' + for_body + ', label %' + for_end);

        ir.push('');
        ir.push(for_body + ':');
        ir.push.apply(ir, toIR(stmt,level,fnames));
        ir.push('  ' + for2 + ' = load i32* ' + index.istack);
        ir.push('  ' + for_cmp2 + ' = icmp eq i32 ' + for2 + ', ' + end.ilocal);
        ir.push('  br i1 ' + for_cmp2 + ', label %' + for_end + ', label %' + for_inc);

        ir.push('');
        ir.push(for_inc + ':');
        ir.push('  ' + for3 + ' = load i32* ' + index.istack);
        ir.push('  ' + for_inc1 + ' = add nsw i32 ' + for3 + ', ' + by);
        ir.push('  store i32 ' + for_inc1 + ', i32* ' + index.istack);
        ir.push('  br label %' + for_cond);

        ir.push('');
        ir.push(for_end + ':');

        ir.push('  ; for statement finish');
        ir.push('');
        break;

      case 'stmt_repeat':
        var expr = ast.expr,
            stmts = ast.stmts,
            repeat_label = st.new_name('repeat'),
            repeat_cond = repeat_label + 'cond',
            repeat_body = repeat_label + 'body',
            repeat_end = repeat_label + 'end';

        ir.push('');
        ir.push('  ; repeat statement start');

        ir.push('  br label %' + repeat_body); 

        ir.push('');
        ir.push(repeat_body + ':');
        for (var i=0; i < stmts.length; i++) {
          ir.push.apply(ir,toIR(stmts[i],level,fnames));
        }
        ir.push('  br label %' + repeat_cond);

        ir.push('');
        ir.push(repeat_cond + ':');
        ir.push.apply(ir, toIR(expr,level,fnames));
        ir.push('  br i1 ' + expr.ilocal + ', label %' + repeat_end + ', label %' + repeat_body);

        ir.push('');
        ir.push(repeat_end + ':');

        ir.push('  ; repeat statement finish');
        ir.push('');
        break;

      case 'stmt_while':
        var expr = ast.expr,
            stmt = ast.stmt,
            while_label = st.new_name('while'),
            while_cond = while_label + 'cond',
            while_body = while_label + 'body',
            while_end = while_label + 'end';

        ir.push('');
        ir.push('  ; while statement start');

        ir.push('  br label %' + while_cond); 

        ir.push('');
        ir.push(while_cond + ':');
        ir.push.apply(ir, toIR(expr,level,fnames));
        ir.push('  br i1 ' + expr.ilocal + ', label %' + while_body + ', label %' + while_end);

        ir.push('');
        ir.push(while_body + ':');
        ir.push.apply(ir, toIR(stmt,level,fnames));
        ir.push('  br label %' + while_cond);

        ir.push('');
        ir.push(while_end + ':');

        ir.push('  ; while statement finish');
        ir.push('');
        break;

      case 'expr_binop':
        var left = ast.left, ltype,
            right = ast.right, rtype,
            resType = null, op,
            dest_name = '%' + st.new_name("binop"),
            boolLookup = {gt:'sgt',lt:'slt',
                          geq:'sge',leq:'sle',
                          eq:'eq',neq:'ne'},
            intLookup = {plus:'add',minus:'sub',
                         star:'mul',slash:'sdiv',
                         div:'sdiv',mod:'urem'},
            fltLookup = {plus:'fadd',minus:'fsub',
                         star:'fmul',slash:'fdiv'};
          
        ir.push.apply(ir, toIR(left,level,fnames));
        ir.push.apply(ir, toIR(right,level,fnames));
        ltype = annotate_type(left.type);
        rtype = annotate_type(right.type);
        if (ast.op in {gt:1,lt:1,geq:1,leq:1,eq:1,neq:1}) {
          var msgPrefix = "Operands for '" + ast.op + "' ";
          // Type-check
          if (ltype.name !== rtype.name) {
            throw new Error(msgPrefix + "are not the same type: " + JSON.stringify(ast));
          }
          if (ast.op in {gt:1,lt:1}) {
            // scalar, string
            if (! (isScalarOrString(ltype) && isScalarOrString(rtype))) {
              throw new Error(msgPrefix + "are not scalar or string");
            }
          } else if (ast.op in {geq:1,leq:1}) {
            // scalar, string, set
            // TODO: sets
            if (! (isScalarOrString(ltype) && isScalarOrString(rtype))) {
              throw new Error(msgPrefix + "are not scalar or string");
            }
          } else if (ast.op in {eq:1,neq:1}) {
            // scalar, string, set or pointer types
            // TODO: sets and pointers
            if (! (isScalarOrString(ltype) && isScalarOrString(rtype))) {
              throw new Error(msgPrefix + "are not scalar or string");
            }
          }
          if (ltype.name === 'REAL') {
            op = 'ficmp ' + boolLookup[ast.op];
          } else {
            op = 'icmp ' + boolLookup[ast.op];
          }
          resType={node:'type',name:'BOOLEAN',lltype:'i1'};
        } else if (ast.op === "plus" &&
            (ltype.name === 'STRING' || ltype.name === 'CHARACTER') &&
            (rtype.name === 'STRING' || rtype.name === 'CHARACTER')) {
         // string concatenation shorthand
         resType = annotate_type({node:'type',name:'STRING',
                                  type:{node:'type',name:'CHARACTER'}});
        } else if (ast.op in {plus:1,minus:1,star:1,slash:1,div:1,mod:1}) {
          if (ast.op === 'slash') {
            resType = {node:'type',name:'REAL',lltype:"float"};
          } else if ((ltype.name === 'INTEGER' && rtype.name === 'INTEGER') ||
                     (ltype.name === 'REAL' && rtype.name === 'REAL')) {
            resType = ltype;
          } else if (ltype.name === 'REAL' && rtype.name === 'INTEGER') {
            resType = ltype;
          } else if (ltype.name === 'INTEGER' && rtype.name === 'REAL') {
            resType = rtype;
          } else {
            throw new Error("No defined behavior for " +
                            ltype.name + " " + ast.op + " " + rtype.name);
          }
          if (resType.name === 'REAL' && ast.op === 'div') {
            throw new Error("div can only be used with Integers");
          }
          if (resType.name === 'REAL') {
            op = fltLookup[ast.op];
          } else {
            op = intLookup[ast.op];
          }
        } else if (ast.op in {and:1,or:1}) {
          op = ast.op;
          resType = left.type;
        } else {
          throw new Error("Unexpected expr_binop operand " + ast.op);
        }
        if (resType.name === 'REAL' && ltype.name === 'INTEGER') {
          var conv = st.new_name("%conv");
          ir.push('  ' + conv + ' = sitofp i32 ' + left.ilocal + ' to float');
          left.ilocal = conv;
          left.itype = 'float';
        }
        if (resType.name === 'REAL' && rtype.name === 'INTEGER') {
          var conv = st.new_name("%conv");
          ir.push('  ' + conv + ' = sitofp i32 ' + right.ilocal + ' to float');
          right.ilocal = conv;
          right.itype = 'float';
        }
        if (resType.name === 'STRING') {
          // string concatenation shorthand
          var fake_expr = {node:'expr_call',id:'CONCAT',call_params:[left, right]};
          ir.push.apply(ir, toIR(fake_expr,level,fnames));
          dest_name = fake_expr.ilocal;
        } else {
          ir.push('  ' + dest_name + ' = ' + op + ' ' + left.itype + ' ' + left.ilocal + ', ' + right.ilocal);
        }
        ast.type = resType;
        ast.itype = resType.lltype;
        ast.ilocal = dest_name;
        break;

      case 'expr_unop':
        var expr = ast.expr,
            dest_name = '%' + st.new_name("unop"),
            op;
        ir.push.apply(ir, toIR(expr,level,fnames));
        // TODO: real typechecking comparison
        switch (ast.op) {
          case 'minus':
            ir.push('  ' + dest_name + ' = sub i32 0, ' + expr.ilocal);
            break;
          case 'not':
            ir.push('  ' + dest_name + ' = xor i1 1, ' + expr.ilocal);
            break;
          default: throw new Error("Unexpected expr_unop operand " + ast.op);
        }
        ast.type = expr.type;
        ast.itype = expr.itype;
        ast.ilocal = dest_name;
        break;

      case 'expr_array_deref':
        var lvalue = ast.lvalue,
            expr = ast.expr;
        ir.push.apply(ir, toIR(expr,level,fnames));
        ir.push.apply(ir, toIR(lvalue,level,fnames));

        var atype = lvalue.type,
            start, rtype, ritype,
            aname = '%' + st.new_name(deref_name(ast)),
            sub = aname + 'sub',
            aptr1 = aname + 'ptr1',
            aoff = aname + 'off',
            aval = aname + 'val';
        // TODO: bounds checking
        start = atype.index.start.val;
        rtype = atype.type;
        ritype = atype.type.lltype;
        if (atype.name === 'STRING') {
          ir.push('  ' + sub + ' = sub ' + expr.itype + ' ' + expr.ilocal + ', ' + start);
          ir.push('  ' + aptr1 + ' = load ' + atype.lltype + '* ' + lvalue.istack);
          ir.push('  ' + aoff + ' = getelementptr inbounds ' + atype.lltype + ' ' + aptr1 + ', i32 ' + sub);
          ir.push('  ' + aval + ' = load ' + atype.lltype + ' ' + aoff);
        } else {
          ir.push('  ' + sub + ' = sub ' + expr.itype + ' ' + expr.ilocal + ', ' + start);
          ir.push('  ' + aoff + ' = getelementptr inbounds ' + atype.lltype + '* ' + lvalue.istack + ', i32 0, ' + expr.itype + ' ' + sub);
          ir.push('  ' + aval + ' = load ' + ritype + '* ' + aoff);
        }
        ast.type = rtype;
        ast.itype = ritype;
        ast.istack = aoff;
        ast.ilocal = aval;
        break;

      case 'expr_record_deref':
        var lvalue = ast.lvalue,
            comp = ast.component;
        ir.push.apply(ir, toIR(lvalue,level,fnames));
        var cidx = lvalue.type.component_map[comp],
            ctype = lvalue.type.sections[cidx].type,
            clltype = ctype.lltype,
            rname = '%' + st.new_name(deref_name(ast)),
            roff = rname + '_off',
            rval = rname + '_val';
        ir.push('  ' + roff + ' = getelementptr inbounds ' + lvalue.itype + '* ' + lvalue.istack + ', i32 0, i32 ' + cidx);
        ir.push('  ' + rval + ' = load ' + clltype + '* ' + roff);
        ast.type = ctype;
        ast.itype = clltype;
        ast.istack = roff;
        ast.ilocal = rval;
        break;

      case 'integer':
        ast.itype = "i32";
        ast.ilocal = ast.val;
        break;
      case 'real':
        ast.itype = "float";
        ast.ilocal = ieee754.llvm_float_hex(ast.val);
        break;
      case 'character':
        ast.itype = "i8";
        ast.ilocal = ast.val;
        break;
      case 'string':
        var slen = ast.val.length+1,
            re = /"/g,
            itype = '[' + slen + ' x i8]',
            sval = 'c"' + ast.val.replace(re, '\\22') + '\\00"',
            lname = '%' + st.new_name('string' + str_cnt),
            sname = '@.string' + (str_cnt++),
            lname;
        ir.push([sname + ' = global ' + itype + ' ' + sval]);
        ir.push('  ' + lname + ' = getelementptr inbounds ' + itype + '* ' + sname + ', i32 0'); 
        ast.itype = itype + '*';
        ast.ilocal = lname;
        ast.istack = sname;
        break;
      case 'boolean':
        ast.itype = "i1";
        ast.ilocal = ast.val.toString();
        break;
      case 'pointer':
        if (ast.id.length === 1) {
          try {
            var pdecl = st.lookup(ast.id);
          } catch(e) {
            // HACK: we could't determine at normal parse time if this is
            // a single character routine or if it's a control character
            // literal. If it's a single character and defined in the
            // symbol table then it's a pointer to a routine, otherwise
            // it's a control character so update the AST (i.e. late
            // parse)
            switch (ast.id) {
              case '@': ast.val = 0; break;
              case 'G': ast.val = 7; break;
              case 'H': ast.val = 8; break;
              case 'I': ast.val = 9; break;
              case 'J': ast.val = 10; break;
              case 'L': ast.val = 12; break;
              case 'M': ast.val = 13; break;
              case '[': ast.val = 27; break;
              case '?': ast.val = 127; break;
              default: throw new Error("Unknown control character " + ast.id);
            }
            ast.node = 'character';
            ast.type = {node:'type',name:'CHARACTER'};
            ast.itype = "i8";
            ast.ilocal = ast.val;
            delete ast.id;
          }
        }
        break;

      case 'variable':
        var vdecl;
        try {
          vdecl = st.lookup(ast.id);
        } catch (e) {
          vdecl = null;
        }

        if (vdecl && vdecl.fparams) {
          // HACK: we could't determine at normal parse time if the ID
          // is a normal ID or a parameter function call. If it's
          // defined as a function, then assume this is actually
          // a parameterless function call expression so replace the
          // AST with a function and evalutate it
          ast.node = 'expr_call';
          ast.call_params = [];
          ir.push.apply(ir, toIR(ast,level,fnames));
          break;
        } else if (!vdecl) {
          throw new Error("Variable '" + ast.id + "' not found in symbol table or in libraries");
        }

        var id = ast.id,
            vtype = annotate_type(vdecl.type),
            vlevel = vdecl.level,
            lname = "%" + st.new_name(id + "_local");

        // Add variables from a higher lexical scope to our current
        // subprogram param list
        if (vlevel > 0 && level !== vlevel) {
          // Variable is in higher lexical scope, simulate static
          // link by passing the variable through intervening
          // sub-programs
          var new_pname, new_sname;
          for(var l = vlevel+1; l <= level; l++) {
            var fname = fnames[l],
                pdecl = st.lookup(fname);
            new_pname = "%" + st.new_name(id + "_lparam");
            new_sname = new_pname + "_stack";
            // replace vdecl and insert it at this level
            vdecl = {node:'var_decl',type:vtype,pname:new_pname,sname:new_sname,var:true,lparam:true,level:l};
            st.insert(id,vdecl,l);
            // add the variable to the lparams (lexical variables) 
            pdecl.lparams.push({node:'variable',id:id,type:vtype});
            st.replace(fname,pdecl);
          }
          ir.push('  ' + new_pname + ' = load ' + vtype.lltype + '* ' + new_sname + ' ; ' + l);
          ast.ilocal = new_pname;
          ast.istack = new_sname;
        }

        ir.push('  ' + lname + ' = load ' + vtype.lltype + '* ' + vdecl.sname);
        ast.type = vtype;
        ast.itype = vtype.lltype;
        ast.ilocal = lname;
        ast.istack = vdecl.sname;
        break;

      default:
        throw new Error("Unknown AST: " + JSON.stringify(ast));
    }

    return ir;
  }

  return {toIR: toIR,
          normalizeIR: normalizeIR,
          displayST: function() { st.display(); },
          getAST: function() { return theAST; }};
}

if (typeof module !== 'undefined') {
  var Parse = require('./parse'),
      ieee754 = require('./ieee754');

  exports.IR = IR;
  exports.toIR = function (ast) {
    var ir = new IR(ast);
    return ir.normalizeIR(ir.toIR());
  };

  exports.main = function commonjsMain(args) {
    if (!args[1]) {
        console.log('Usage: '+args[0]+' FILE');
        process.exit(1);
    }
    var source = require('fs').readFileSync(require('path').normalize(args[1]), "utf8"),
        ast = Parse.parser.parse(source);
    console.log(exports.toIR(ast));
  }
  if (require.main === module) {
    exports.main(process.argv.slice(1));
  }
}

// vim: expandtab:ts=2:sw=2:syntax=javascript
