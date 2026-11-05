import {timingSafeEqual} from 'node:crypto';
export function authorizeMutation({origin,token,expectedToken,allowedOrigins}){
  if(origin&&!allowedOrigins.includes(origin))throw Object.assign(new Error('Origin is not allowed'),{statusCode:403});
  const a=Buffer.from(token||''),b=Buffer.from(expectedToken);if(a.length!==b.length||!timingSafeEqual(a,b))throw Object.assign(new Error('Valid local session token required'),{statusCode:403});
}
