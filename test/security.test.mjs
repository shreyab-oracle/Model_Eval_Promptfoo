import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeMutation} from '../src/http/security.mjs';
test('mutations reject foreign origins even with a valid local token',()=>assert.throws(()=>authorizeMutation({origin:'https://attacker.invalid',token:'abc',expectedToken:'abc',allowedOrigins:['http://127.0.0.1:5173']}),/Origin/));
test('mutations reject missing session tokens and accept the correct same-origin token',()=>{assert.throws(()=>authorizeMutation({expectedToken:'abc',allowedOrigins:[]}),/token/);assert.doesNotThrow(()=>authorizeMutation({token:'abc',expectedToken:'abc',allowedOrigins:[]}));});
