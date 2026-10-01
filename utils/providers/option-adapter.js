class IncompatibleRequestError extends Error {
  constructor(message, unadaptableOption) {
    super(message);
    this.name = 'IncompatibleRequestError';
    this.unadaptableOption = unadaptableOption;
  }
}

/**
 * Safely adapts request options for a fallback provider.
 * @param {Object} originalOptions - The original request options.
 * @param {Object} providerRecord - The capability record of the candidate provider.
 * @returns {Object} { adaptedOptions, adaptationsLog }
 * @throws {IncompatibleRequestError} If adaptation is unsafe or impossible.
 */
function adaptOptions(originalOptions, providerRecord) {
  const options = { ...originalOptions };
  const log = [];
  
  // Extract explicit required/optional constraints from the request, if any.
  // By default, everything is required unless specified in _optional, 
  // or everything is optional except what's in _required. 
  // We'll treat standard fields as safely adaptable if the provider explicitly supports adaptation.
  const requiredFields = Array.isArray(options._required) ? options._required : [];
  const optionalFields = Array.isArray(options._optional) ? options._optional : [];
  
  // Clean up metadata
  delete options._required;
  delete options._optional;
  delete options.request;

  const safeAdaptations = Array.isArray(providerRecord.adaptations) 
    ? providerRecord.adaptations 
    : ['resolution', 'format']; // Default safe adaptations if not strictly specified

  // 1. Resolution Adaptation
  if (options.resolution && providerRecord.resolution) {
    const orig = parseResolution(options.resolution);
    const max = parseResolution(providerRecord.resolution.max);
    
    if (orig && max && (orig.width > max.width || orig.height > max.height)) {
      if (!safeAdaptations.includes('resolution')) {
        throw new IncompatibleRequestError(
          `Resolution ${options.resolution} is too high for provider max ${providerRecord.resolution.max}, and resolution adaptation is not permitted.`,
          'resolution'
        );
      }
      if (requiredFields.includes('resolution')) {
        throw new IncompatibleRequestError(
          `Resolution is marked as STRICTLY REQUIRED, cannot safely downscale from ${options.resolution} to ${providerRecord.resolution.max}.`,
          'resolution'
        );
      }
      
      const newRes = `${max.width}x${max.height}`;
      log.push(`Resolution safely downscaled from ${options.resolution} to ${newRes}`);
      options.resolution = newRes;
    }
  }

  // 2. Format Adaptation
  if (options.format && providerRecord.output?.formats && providerRecord.output.formats.length > 0) {
    if (!providerRecord.output.formats.includes(options.format)) {
       if (!safeAdaptations.includes('format')) {
         throw new IncompatibleRequestError(
           `Format ${options.format} is unsupported by provider, and format conversion is not permitted.`,
           'format'
         );
       }
       if (requiredFields.includes('format')) {
         throw new IncompatibleRequestError(
           `Format is marked as STRICTLY REQUIRED, cannot adapt away from ${options.format}.`,
           'format'
         );
       }
       const fallbackFormat = providerRecord.output.formats[0];
       log.push(`Format safely adapted from ${options.format} to ${fallbackFormat}`);
       options.format = fallbackFormat;
    }
  }

  // 3. Check for unsupported arbitrary options
  // If the provider explicitly lists unsupported fields, we must handle them.
  if (providerRecord.unsupportedOptions) {
    for (const key of providerRecord.unsupportedOptions) {
      if (options[key] !== undefined) {
        if (requiredFields.includes(key) || !optionalFields.includes(key)) {
           throw new IncompatibleRequestError(
             `Provider explicitly does not support required option: ${key}`,
             key
           );
        } else {
           // Safely remove unsupported optional parameter
           delete options[key];
           log.push(`Removed unsupported optional parameter: ${key}`);
        }
      }
    }
  }

  return { adaptedOptions: options, adaptationsLog: log };
}

function parseResolution(resString) {
  if (typeof resString !== 'string') return null;
  const parts = resString.toLowerCase().split('x');
  if (parts.length === 2) {
    const w = parseInt(parts[0], 10);
    const h = parseInt(parts[1], 10);
    if (!isNaN(w) && !isNaN(h)) return { width: w, height: h };
  }
  return null;
}

module.exports = {
  adaptOptions,
  IncompatibleRequestError
};
