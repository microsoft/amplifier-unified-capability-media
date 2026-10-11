// Public copy is fixed here; credentials, provider bodies and callback errors
// never become user-facing diagnostic text.
const messages={
 voice_previous_call_unverified:[409,'The earlier call has not been confirmed ended. End it or contact the installation owner before calling again.'],
 voice_start_busy:[409,'A call or preview is starting for this client. Wait for its result before starting another.'],
 voice_access_disabled:[403,'Voice access is turned off for this installation. Ask its owner to enable it.'],
 voice_credentials_missing:[409,'Add an OpenAI API key in Voice settings to start calls and previews.'],
 voice_unavailable:[503,'Voice is unavailable. Open Voice settings or contact the installation owner.'],
 voice_settings_unavailable:[503,'Voice settings could not be read. Reopen Voice settings or contact the installation owner.'],
 voice_configuration_invalid:[400,'Choose a credential source and enter a single-line API key in Voice settings.'],
 voice_configuration_unknown:[502,'Voice settings could not be confirmed. Reopen Voice settings before saving again.'],
 voice_credentials_invalid:[401,'The voice key was rejected. Update it in Voice settings.'],
 voice_model_unavailable:[403,'Your account cannot use this voice model. Choose another model or check account access.'],
 voice_rate_limited:[429,'Voice is temporarily limited. Check your account usage or try again later.'],
 voice_connection_unknown:[502,'The voice connection could not be confirmed. Check the call status before trying again.'],
 voice_preview_unknown:[502,'The voice preview could not be confirmed. Check Voice settings before trying again.'],
};
export function voiceFailure(code,executed){const [status,message]=messages[code];return Object.assign(Error(message),{status,code,voicePublic:true,...(executed===false?{executed:false}:{})});}
export function voiceAvailability(value){return value.credentialAccess==='disabled'?'disabled':value.available===true?'configured':value.credentialAccess==='enabled'&&value.available===false?'missing-credentials':'unavailable';}
export function availabilityReason(state){return state==='configured'?null:messages[state==='disabled'?'voice_access_disabled':state==='missing-credentials'?'voice_credentials_missing':'voice_unavailable'][1];}
export function requireVoice(configuration){if(configuration.availability!=='configured')throw voiceFailure(configuration.availability==='disabled'?'voice_access_disabled':configuration.availability==='missing-credentials'?'voice_credentials_missing':'voice_unavailable',false);}
export function voiceErrorResponse(error,path){
 const sensitive=['/media/voice/connect','/media/voice/preview','/media/voice/configure','/media/voice/config'].includes(path);
 let failure=error;
 if(!failure.voicePublic&&!failure.mediaPublic&&sensitive){
  const status=error.data?.source==='voice-provider'?error.data.status:undefined;
  const code=status===401?'voice_credentials_invalid':[400,403,404].includes(status)?'voice_model_unavailable':status===429?'voice_rate_limited':path.endsWith('/configure')?'voice_configuration_unknown':path.endsWith('/config')?'voice_settings_unavailable':path.endsWith('/preview')?'voice_preview_unknown':'voice_connection_unknown';
  failure=voiceFailure(code,error.data?.executed===false?false:undefined);
 }
 return Response.json({error:failure.message,code:failure.voicePublic?failure.code:'media_error',...(failure.voicePublic?{outcome:failure.executed===false?'rejected':'unknown',retryable:false,...(failure.executed===false?{executed:false}:{})}:{})},{status:failure.status||502,headers:{'Cache-Control':'no-store'}});
}
