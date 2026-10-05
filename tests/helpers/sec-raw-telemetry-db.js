import { createRawRuntimeDatabase } from './sec-standard-raw-runtime-db.js';

/** SQLite 의미를 실제 실행하고 D1-shaped 합성 meta를 붙인다. 과금 rows/실제 CPU를 모사한 실측값이 아니다. */
export function createTelemetryTestDatabase() {
  const ctx=createRawRuntimeDatabase(22);
  const totals={calls:0,statements:0,rowsRead:0,rowsWritten:0,duration:0};
  const result = (value,stat) => {
    const meta={rows_read:3,rows_written:stat.logicalChanges,duration:0.25,changes:stat.logicalChanges};
    totals.rowsRead+=meta.rows_read;totals.rowsWritten+=meta.rows_written;totals.duration+=meta.duration;
    return {success:true,results:value?.results??[],meta};
  };
  const prepare = sql => {
    const statement=ctx.DB.prepare(sql);
    return {sql,statement,bind(...values){statement.bind(...values);return this;},
      async all(){totals.calls++;totals.statements++;return result(await statement.all(),ctx.stats.at(-1));},
      async run(){totals.calls++;totals.statements++;return result(await statement.run(),ctx.stats.at(-1));},
      async first(column){const r=(await this.all()).results[0];if(!r)return null;
        if(column===undefined)return r;if(r[column]===undefined)throw Error('D1_COLUMN_NOTFOUND: Column not found');return r[column];}
    };
  };
  const DB={prepare,async batch(statements){
    totals.calls++;totals.statements+=statements.length;
    const offset=ctx.stats.length,results=await ctx.DB.batch(statements.map(s=>s.statement));
    return results.map((value,i)=>result(value,ctx.stats[offset+i]));
  }};
  return {...ctx,DB,totals,sqlite:ctx.sqlite,stats:ctx.stats,
    reset(){ctx.reset();for(const key of Object.keys(totals))totals[key]=0;}};
}
