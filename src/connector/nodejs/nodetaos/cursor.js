const ref = require('ref-napi');
require('./globalfunc.js')
const CTaosInterface = require('./cinterface')
const errors = require('./error')
const TaosQuery = require('./taosquery')
const { PerformanceObserver, performance } = require('perf_hooks');
module.exports = TDengineCursor;

/**
 * @typedef {Object} Buffer - A Node.js buffer. Please refer to {@link https://nodejs.org/api/buffer.html} for more details
 * @global
 */

/**
 * @class TDengineCursor
 * @classdesc  The TDengine Cursor works directly with the C Interface which works with TDengine. It refrains from
 * returning parsed data and majority of functions return the raw data such as cursor.fetchall() as compared to the TaosQuery class which
 * has functions that "prettify" the data and add more functionality and can be used through cursor.query("your query"). Instead of
 * promises, the class and its functions use callbacks.
 * @param {TDengineConnection} - The TDengine Connection this cursor uses to interact with TDengine
 * @property {data} - Latest retrieved data from query execution. It is an empty array by default
 * @property {fields} - Array of the field objects in order from left to right of the latest data retrieved
 * @since 1.0.0
 */
function TDengineCursor(connection = null) {
  //All parameters are store for sync queries only.
  this._rowcount = -1;
  this._connection = null;
  this._result = null;
  this._fields = null;
  this.data = [];
  this.fields = null;
  this._stmt = null;
  if (connection != null) {
    this._connection = connection
    this._chandle = connection._chandle //pass through, just need library loaded.
  }
  else {
    throw new errors.ProgrammingError("A TDengineConnection object is required to be passed to the TDengineCursor");
  }

}
/**
 * Get the row counts of the latest query
 * @since 1.0.0
 * @return {number} Rowcount
 */
TDengineCursor.prototype.rowcount = function rowcount() {
  return this._rowcount;
}
/**
 * Close the cursor by setting its connection to null and freeing results from the connection and resetting the results it has stored
 * @return {boolean} Whether or not the cursor was succesfully closed
 * @since 1.0.0
 */
TDengineCursor.prototype.close = function close() {
  if (this._connection == null) {
    return false;
  }
  this._connection._clearResultSet();
  this._reset_result();
  this._connection = null;
  return true;
}
/**
 * Create a TaosQuery object to perform a query to TDengine and retrieve data.
 * @param {string} operation - The operation string to perform a query on
 * @param {boolean} execute - Whether or not to immedietely perform the query. Default is false.
 * @return {TaosQuery | Promise<TaosResult>} A TaosQuery object
 * @example
 * var query = cursor.query("select count(*) from meterinfo.meters");
 * query.execute();
 * @since 1.0.6
 */
TDengineCursor.prototype.query = function query(operation, execute = false) {
  return new TaosQuery(operation, this, execute);
}

/**
 * Execute a query. Also stores all the field meta data returned from the query into cursor.fields. It is preferable to use cursor.query() to create
 * queries and execute them instead of using the cursor object directly.
 * @param {string} operation - The query operation to execute in the taos shell
 * @param {Object} options - Execution options object. quiet : true turns off logging from queries
 * @param {boolean} options.quiet - True if you want to surpress logging such as "Query OK, 1 row(s) ..."
 * @param {function} callback - A callback function to execute after the query is made to TDengine
 * @return {number | Buffer} Number of affected rows or a Buffer that points to the results of the query
 * @since 1.0.0
 */
TDengineCursor.prototype.execute = function execute(operation, options, callback) {
  if (operation == undefined) {
    throw new errors.ProgrammingError('No operation passed as argument');
    return null;
  }

  if (typeof options == 'function') {
    callback = options;
  }
  if (typeof options != 'object') options = {}
  if (this._connection == null) {
    throw new errors.ProgrammingError('Cursor is not connected');
  }

  this._reset_result();

  let stmt = operation;
  let time = 0;
  let res;
  if (options['quiet'] != true) {
    const obs = new PerformanceObserver((items) => {
      time = items.getEntries()[0].duration;
      performance.clearMarks();
    });
    obs.observe({ entryTypes: ['measure'] });
    performance.mark('A');
    this._result = this._chandle.query(this._connection._conn, stmt);
    performance.mark('B');
    performance.measure('query', 'A', 'B');
  }
  else {
    this._result = this._chandle.query(this._connection._conn, stmt);
  }
  res = this._chandle.errno(this._result);
  if (res == 0) {
    let fieldCount = this._chandle.fieldsCount(this._result);
    if (fieldCount == 0) {
      let affectedRowCount = this._chandle.affectedRows(this._result);
      let response = this._createAffectedResponse(affectedRowCount, time)
      if (options['quiet'] != true) {
        console.log(response);
      }
      wrapCB(callback);
      return affectedRowCount; //return num of affected rows, common with insert, use statements
    }
    else {
      this._fields = this._chandle.useResult(this._result);
      this.fields = this._fields;
      wrapCB(callback);

      return this._result; //return a pointer to the result
    }
  }
  else {
    throw new errors.ProgrammingError(this._chandle.errStr(this._result))
  }

}
TDengineCursor.prototype._createAffectedResponse = function (num, time) {
  return "Query OK, " + num + " row(s) affected (" + (time * 0.001).toFixed(8) + "s)";
}
TDengineCursor.prototype._createSetResponse = function (num, time) {
  return "Query OK, " + num + " row(s) in set (" + (time * 0.001).toFixed(8) + "s)";
}
TDengineCursor.prototype.executemany = function executemany() {

}
TDengineCursor.prototype.fetchone = function fetchone() {

}
TDengineCursor.prototype.fetchmany = function fetchmany() {

}
/**
 * Fetches all results from a query and also stores results into cursor.data. It is preferable to use cursor.query() to create
 * queries and execute them instead of using the cursor object directly.
 * @param {function} callback - callback function executing on the complete fetched data
 * @return {Array<Array>} The resultant array, with entries corresponding to each retreived row from the query results, sorted in
 * order by the field name ordering in the table.
 * @since 1.0.0
 * @example
 * cursor.execute('select * from db.table');
 * var data = cursor.fetchall(function(results) {
 *   results.forEach(row => console.log(row));
 * })
 */
TDengineCursor.prototype.fetchall = function fetchall(options, callback) {
  if (this._result == null || this._fields == null) {
    throw new errors.OperationalError("Invalid use of fetchall, either result or fields from query are null. First execute a query first");
  }

  let num_of_rows = this._chandle.affectedRows(this._result);
  let data = new Array(num_of_rows);

  this._rowcount = 0;

  let time = 0;
  const obs = new PerformanceObserver((items) => {
    time += items.getEntries()[0].duration;
    performance.clearMarks();
  });
  obs.observe({ entryTypes: ['measure'] });
  performance.mark('A');
  while (true) {
    let blockAndRows = this._chandle.fetchBlock(this._result, this._fields);
    // console.log(blockAndRows);
    // break;
    let block = blockAndRows.blocks;
    let num_of_rows = blockAndRows.num_of_rows;
    if (num_of_rows == 0) {
      break;
    }
    this._rowcount += num_of_rows;
    let numoffields = this._fields.length;
    for (let i = 0; i < num_of_rows; i++) {
      // data.push([]);

      let rowBlock = new Array(numoffields);
      for (let j = 0; j < numoffields; j++) {
        rowBlock[j] = block[j][i];
      }
      data[this._rowcount - num_of_rows + i] = (rowBlock);
      // data.push(rowBlock);
    }

  }

  performance.mark('B');
  performance.measure('query', 'A', 'B');
  let response = this._createSetResponse(this._rowcount, time)
  console.log(response);

  // this._connection._clearResultSet();
  let fields = this.fields;
  this._reset_result();
  this.data = data;
  this.fields = fields;

  wrapCB(callback, data);

  return data;
}
/**
 * Asynchrnously execute a query to TDengine. NOTE, insertion requests must be done in sync if on the same table.
 * @param {string} operation - The query operation to execute in the taos shell
 * @param {Object} options - Execution options object. quiet : true turns off logging from queries
 * @param {boolean} options.quiet - True if you want to surpress logging such as "Query OK, 1 row(s) ..."
 * @param {function} callback - A callback function to execute after the query is made to TDengine
 * @return {number | Buffer} Number of affected rows or a Buffer that points to the results of the query
 * @since 1.0.0
 */
TDengineCursor.prototype.execute_a = function execute_a(operation, options, callback, param) {
  if (operation == undefined) {
    throw new errors.ProgrammingError('No operation passed as argument');
    return null;
  }
  if (typeof options == 'function') {
    //we expect the parameter after callback to be param
    param = callback;
    callback = options;
  }
  if (typeof options != 'object') options = {}
  if (this._connection == null) {
    throw new errors.ProgrammingError('Cursor is not connected');
  }
  if (typeof callback != 'function') {
    throw new errors.ProgrammingError("No callback function passed to execute_a function");
  }
  // Async wrapper for callback;
  var cr = this;

  let asyncCallbackWrapper = function (param2, res2, resCode) {
    if (typeof callback == 'function') {
      callback(param2, res2, resCode);
    }

    if (resCode >= 0) {
      //      let fieldCount = cr._chandle.numFields(res2);
      //      if (fieldCount == 0) {
      //        //cr._chandle.freeResult(res2);
      //        return res2;
      //      } 
      //      else {
      //        return res2;
      //      }
      return res2;

    }
    else {
      throw new errors.ProgrammingError("Error occuring with use of execute_a async function. Status code was returned with failure");
    }
  }

  let stmt = operation;
  let time = 0;

  // Use ref module to write to buffer in cursor.js instead of taosquery to maintain a difference in levels. Have taosquery stay high level
  // through letting it pass an object as param
  var buf = ref.alloc('Object');
  ref.writeObject(buf, 0, param);
  const obs = new PerformanceObserver((items) => {
    time = items.getEntries()[0].duration;
    performance.clearMarks();
  });
  obs.observe({ entryTypes: ['measure'] });
  performance.mark('A');
  this._chandle.query_a(this._connection._conn, stmt, asyncCallbackWrapper, buf);
  performance.mark('B');
  performance.measure('query', 'A', 'B');
  return param;


}
/**
 * Fetches all results from an async query. It is preferable to use cursor.query_a() to create
 * async queries and execute them instead of using the cursor object directly.
 * @param {Object} options - An options object containing options for this function
 * @param {function} callback - callback function that is callbacked on the COMPLETE fetched data (it is calledback only once!).
 * Must be of form function (param, result, rowCount, rowData)
 * @param {Object} param - A parameter that is also passed to the main callback function. Important! Param must be an object, and the key "data" cannot be used
 * @return {{param:Object, result:Buffer}} An object with the passed parameters object and the buffer instance that is a pointer to the result handle.
 * @since 1.2.0
 * @example
 * cursor.execute('select * from db.table');
 * var data = cursor.fetchall(function(results) {
 *   results.forEach(row => console.log(row));
 * })
 */
TDengineCursor.prototype.fetchall_a = function fetchall_a(result, options, callback, param = {}) {
  if (typeof options == 'function') {
    //we expect the parameter after callback to be param
    param = callback;
    callback = options;
  }
  if (typeof options != 'object') options = {}
  if (this._connection == null) {
    throw new errors.ProgrammingError('Cursor is not connected');
  }
  if (typeof callback != 'function') {
    throw new errors.ProgrammingError('No callback function passed to fetchall_a function')
  }
  if (param.data) {
    throw new errors.ProgrammingError("You aren't allowed to set the key 'data' for the parameters object");
  }
  let buf = ref.alloc('Object');
  param.data = [];
  var cr = this;

  // This callback wrapper accumulates the data from the fetch_rows_a function from the cinterface. It is accumulated by passing the param2
  // object which holds accumulated data in the data key.
  let asyncCallbackWrapper = function asyncCallbackWrapper(param2, result2, numOfRows2, rowData) {
    param2 = ref.readObject(param2); //return the object back from the pointer
    if (numOfRows2 > 0 && rowData.length != 0) {
      // Keep fetching until now rows left.
      let buf2 = ref.alloc('Object');
      param2.data.push(rowData);
      ref.writeObject(buf2, 0, param2);
      cr._chandle.fetch_rows_a(result2, asyncCallbackWrapper, buf2);
    }
    else {
      let finalData = param2.data;
      let fields = cr._chandle.fetchFields_a(result2);
      let data = [];
      for (let i = 0; i < finalData.length; i++) {
        let num_of_rows = finalData[i][0].length; //fetched block number i;
        let block = finalData[i];
        for (let j = 0; j < num_of_rows; j++) {
          data.push([]);
          let rowBlock = new Array(fields.length);
          for (let k = 0; k < fields.length; k++) {
            rowBlock[k] = block[k][j];
          }
          data[data.length - 1] = rowBlock;
        }
      }
      cr._chandle.freeResult(result2); // free result, avoid seg faults and mem leaks!
      callback(param2, result2, numOfRows2, { data: data, fields: fields });

    }
  }
  ref.writeObject(buf, 0, param);
  param = this._chandle.fetch_rows_a(result, asyncCallbackWrapper, buf); //returned param
  return { param: param, result: result };
}
/**
 * Stop a query given the result handle.
 * @param {Buffer} result - The buffer that acts as the result handle
 * @since 1.3.0
 */
TDengineCursor.prototype.stopQuery = function stopQuery(result) {
  this._chandle.stopQuery(result);
}
TDengineCursor.prototype._reset_result = function _reset_result() {
  this._rowcount = -1;
  if (this._result != null) {
    this._chandle.freeResult(this._result);
  }
  this._result = null;
  this._fields = null;
  this.data = [];
  this.fields = null;
}
/**
 * Get server info such as version number
 * @return {string}
 * @since 1.3.0
 */
TDengineCursor.prototype.getServerInfo = function getServerInfo() {
  return this._chandle.getServerInfo(this._connection._conn);
}
/**
 * Get client info such as version number
 * @return {string}
 * @since 1.3.0
 */
TDengineCursor.prototype.getClientInfo = function getClientInfo() {
  return this._chandle.getClientInfo();
}
/**
 * Subscribe to a table from a database in TDengine.
 * @param {Object} config - A configuration object containing the configuration options for the subscription
 * @param {string} config.restart - whether or not to continue a subscription if it already exits, otherwise start from beginning
 * @param {string} config.topic - The unique identifier of a subscription
 * @param {string} config.sql - A sql statement for data query
 * @param {string} config.interval - The pulling interval
 * @return {Buffer} A buffer pointing to the subscription session handle
 * @since 1.3.0
 */
TDengineCursor.prototype.subscribe = function subscribe(config) {
  let restart = config.restart ? 1 : 0;
  return this._chandle.subscribe(this._connection._conn, restart, config.topic, config.sql, config.interval);
};
/**
 * An infinite loop that consumes the latest data and calls a callback function that is provided.
 * @param {Buffer} subscription - A buffer object pointing to the subscription session handle
 * @param {function} callback - The callback function that takes the row data, field/column meta data, and the subscription session handle as input
 * @since 1.3.0
 */
TDengineCursor.prototype.consumeData = async function consumeData(subscription, callback) {
  while (true) {
    let { data, fields, result } = this._chandle.consume(subscription);
    callback(data, fields, result);
  }
}
/**
 * Unsubscribe the provided buffer object pointing to the subscription session handle
 * @param {Buffer} subscription - A buffer object pointing to the subscription session handle that is to be unsubscribed
 * @since 1.3.0
 */
TDengineCursor.prototype.unsubscribe = function unsubscribe(subscription) {
  this._chandle.unsubscribe(subscription);
}

/**
 * schemaless insert 
 * @param {*} connection a valid database connection
 * @param {*} lines string data, which statisfied with line proctocol
 * @param {*} protocal Line protocol, enum type (0,1,2,3),indicate different line protocol
 * @param {*} precision timestamp precision in lines, enum type (0,1,2,3,4,5,6)
 * @returns TAOS_RES 
 * 
 */
TDengineCursor.prototype.schemalessInsert = function schemalessInsert(lines, protocol, precision) {
  this._result = this._chandle.schemalessInsert(this._connection._conn, lines, protocol, precision);
  let errorNo = this._chandle.errno(this._result);
  if (errorNo != 0) {
    throw new errors.InterfaceError(errorNo + ":" + this._chandle.errStr(this._result));
  }
  this._chandle.freeResult(this._result);
}

//STMT
/**
 * init a TAOS_STMT object for later use.it should be freed with stmtClose.
 * @returns  Not NULL returned for success, and NULL for failure. 
 * 
 */
TDengineCursor.prototype.stmtInit = function stmtInit() {
  let stmt = null
  stmt = this._chandle.stmtInit(this._connection._conn);
  if (stmt == null || stmt == undefined) {
    throw new errors.DatabaseError(this._chandle.stmtErrStr(stmt));
  } else {
    this._stmt = stmt;
  }
}

/**
 * prepare a sql statement,'sql' should be a valid INSERT/SELECT statement
 * @param {string} sql  a valid INSERT/SELECT statement
 * @returns {int}	0 for success, non-zero for failure.
 */
TDengineCursor.prototype.stmtPrepare = function stmtPrepare(sql) {
  if (this._stmt == null) {
    throw new errors.DatabaseError("stmt is null,init stmt first");
  } else {
    let stmtPrepare = this._chandle.stmtPrepare(this._stmt, sql, null);
    if (stmtPrepare != 0) {
      throw new errors.DatabaseError(this._chandle.stmtErrStr(this._stmt));
    } else {
      console.log("stmtPrepare success.");
    }
  }
}

/**
 * For INSERT only. Used to bind table name as a parmeter for the input stmt object.
 * @param {TaosBind} tableName target table name you want to  bind
 * @returns 0 for success, non-zero for failure.
 */
TDengineCursor.prototype.stmtSetTbname = function stmtSetTbname(tableName) {
  if (this._stmt == null) {
    throw new errors.DatabaseError("stmt is null,init stmt first");
  } else {
    let stmtPrepare = this._chandle.stmtSetTbname(this._stmt, tableName);
    if (stmtPrepare != 0) {
      throw new errors.DatabaseError(this._chandle.stmtErrStr(this._stmt));
    } else {
      console.log("stmtSetTbname success.");
    }
  }
}

/**
 * For INSERT only. 
 * Set a table name for binding table name as parameter and tag values for all  tag parameters. 
 * @param {*} tableName use to set target table name
 * @param {TaosMultiBind} tags use to set tag value for target table. 
 * @returns 
 */
TDengineCursor.prototype.stmtSetTbnameTags = function stmtSetTbnameTags(tableName, tags) {
  if (this._stmt == null) {
    throw new errors.DatabaseError("stmt is null,init stmt first");
  } else {
    let stmtPrepare = this._chandle.stmtSetTbnameTags(this._stmt, tableName, tags);
    if (stmtPrepare != 0) {
      throw new errors.DatabaseError(this._chandle.stmtErrStr(this._stmt));
    } else {
      console.log("stmtSetTbnameTags success.");
    }
  }
}

/**
 * For INSERT only. 
 * Set a table name for binding table name as parameter. Only used for binding all tables
 * in one stable, user application must call 'loadTableInfo' API to load all table
 * meta before calling this API. If the table meta is not cached locally, it will return error.
 * @param {*} subTableName table name which is belong to an stable
 * @returns 0 for success, non-zero for failure.
 */
TDengineCursor.prototype.stmtSetSubTbname = function stmtSetSubTbname(subTableName) {
  if (this._stmt == null) {
    throw new errors.DatabaseError("stmt is null,init stmt first");
  } else {
    let stmtPrepare = this._chandle.stmtSetSubTbname(this._stmt, subTableName);
    if (stmtPrepare != 0) {
      throw new errors.DatabaseError(this._chandle.stmtErrStr(this._stmt));
    } else {
      console.log("stmtSetSubTbname success.");
    }
  }
}

/**
 * bind a whole line data, for both INSERT and SELECT. The parameter 'bind' points to an array 
 * contains the whole line data. Each item in array represents a column's value, the item 
 * number and sequence should keep consistence with columns in sql statement. The usage of 
 * structure TAOS_BIND is the same with MYSQL_BIND in MySQL.
 * @param {*} binds points to an array contains the whole line data.
 * @returns 	0 for success, non-zero for failure.
 */
TDengineCursor.prototype.stmtBindParam = function stmtBindParam(binds) {
  if (this._stmt == null) {
    throw new errors.DatabaseError("stmt is null,init stmt first");
  } else {
    let stmtPrepare = this._chandle.bindParam(this._stmt, binds);
    if (stmtPrepare != 0) {
      throw new errors.DatabaseError(this._chandle.stmtErrStr(this._stmt));
    } else {
      console.log("bindParam success.");
    }
  }
}

/**
 * Bind a single column's data, INTERNAL used and for INSERT only. 
 * @param {TaosMultiBind} mbind points to a column's data which could be the one or more lines. 
 * @param {*} colIndex the column's index in prepared sql statement, it starts from 0.
 * @returns 0 for success, non-zero for failure.
 */
TDengineCursor.prototype.stmtBindSingleParamBatch = function stmtBindSingleParamBatch(mbind, colIndex) {
  if (this._stmt == null) {
    throw new errors.DatabaseError("stmt is null,init stmt first");
  } else {
    let stmtPrepare = this._chandle.stmtBindSingleParamBatch(this._stmt, mbind, colIndex);
    if (stmtPrepare != 0) {
      throw new errors.DatabaseError(this._chandle.stmtErrStr(this._stmt));
    } else {
      console.log("stmtBindSingleParamBatch success.");
    }
  }
}

/**
 * For INSERT only.
 * Bind one or multiple lines data.
 * @param {*} mbinds Points to an array contains one or more lines data.The item 
 *            number and sequence should keep consistence with columns
 *            n sql statement. 
 * @returns  0 for success, non-zero for failure.
 */
TDengineCursor.prototype.stmtBindParamBatch = function stmtBindParamBatch(mbinds) {
  if (this._stmt == null) {
    throw new errors.DatabaseError("stmt is null,init stmt first");
  } else {
    let stmtPrepare = this._chandle.stmtBindParamBatch(this._stmt, mbinds);
    if (stmtPrepare != 0) {
      throw new errors.DatabaseError(this._chandle.stmtErrStr(this._stmt));
    } else {
      console.log("stmtBindParamBatch success.");
    }
  }
}

/**
 * add all current bound parameters to batch process, for INSERT only.
 * Must be called after each call to bindParam/bindSingleParamBatch, 
 * or all columns binds for one or more lines with bindSingleParamBatch. User 
 * application can call any bind parameter API again to bind more data lines after calling
 * to this API.
 * @param {*} stmt 
 * @returns 	0 for success, non-zero for failure.
 */
TDengineCursor.prototype.stmtAddBatch = function stmtAddBatch() {
  if (this._stmt == null) {
    throw new errors.DatabaseError("stmt is null,init stmt first");
  } else {
    let addBatchRes = this._chandle.addBatch(this._stmt);
    if (addBatchRes != 0) {
      throw new errors.DatabaseError(this._chandle.stmtErrStr(this._stmt));
    }
    else {
      console.log("addBatch success.");
    }
  }
}

/**
 * actually execute the INSERT/SELECT sql statement. User application can continue
 * to bind new data after calling to this API.
 * @param {*} stmt 
 * @returns 	0 for success, non-zero for failure.
 */
TDengineCursor.prototype.stmtExecute = function stmtExecute() {
  if (this._stmt != null) {
    let stmtExecRes = this._chandle.stmtExecute(this._stmt);
    if (stmtExecRes != 0) {
      throw new errors.DatabaseError(this._chandle.stmtErrStr(this._stmt));
    } else {
      console.log("stmtExecute success.")
    }
  } else {
    throw new errors.DatabaseError("stmt is null,init stmt first");
  }
}

/**
 * For SELECT only,getting the query result. 
 * User application should free it with API 'FreeResult' at the end.
 * @returns Not NULL for success, NULL for failure.
 */
TDengineCursor.prototype.stmtUseResult = function stmtUseResult() {
  if (this._stmt != null) {
    this._result = this._chandle.stmtUseResult(this._stmt);
    let res = this._chandle.errno(this._result);
    if (res != 0) {
      throw new errors.DatabaseError(this._chandle.errStr(this._stmt));
    } else {
      console.log("stmtUseResult success.");
      let fieldCount = this._chandle.fieldsCount(this._result);
      if (fieldCount != 0) {
        this._fields = this._chandle.useResult(this._result);
        this.fields = this._fields;
      }
    }
  } else {
    throw new errors.DatabaseError("stmt is null,init stmt first");
  }
}

/**
 * user application call this API to load all tables meta info.
 * This method must be called before stmtSetSubTbname(IntPtr stmt, string name);
 * @param {*} tableList tables need to load meta info are form in an array
 * @returns 0 for success, non-zero for failure.
 */
TDengineCursor.prototype.loadTableInfo = function loadTableInfo(tableList) {
  if (this._connection._conn != null) {
    let stmtExecRes = this._chandle.loadTableInfo(this._connection._conn, tableList);
    if (stmtExecRes != 0) {
      throw new errors.DatabaseError(`loadTableInfo() failed,code ${stmtExecRes}`);
    } else {
      console.log("loadTableInfo success.")
    }
  } else {
    throw new errors.DatabaseError("taos connection is null.");
  }
}

/**
 * close STMT object and free resources.
 * @param {*} stmt 
 * @returns 0 for success, non-zero for failure.
 */
TDengineCursor.prototype.stmtClose = function stmtClose() {
  if (this._stmt == null) {
    throw new DatabaseError("stmt is null,init stmt first");
  } else {
    let closeStmtRes = this._chandle.closeStmt(this._stmt);
    if (closeStmtRes != 0) {
      throw new DatabaseError(this._chandle.stmtErrStr(this._stmt));
    }
    else {
      console.log("closeStmt success.");
    }
  }
}