export const EXECUTION_PROTOCOL_VERSION='durable-received-v1';

export function assertExecutionProtocol(snapshot){
  if(snapshot?.executionProtocolVersion!==EXECUTION_PROTOCOL_VERSION)throw Object.assign(new Error('Frozen execution protocol differs from this application version. Prepare a new run; do not resume older work.'),{code:'EXECUTION_PROTOCOL_MISMATCH'});
}
