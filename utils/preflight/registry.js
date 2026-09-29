const { SEVERITY, CATEGORIES, STATUS, CAPABILITIES } = require('./status');

class Requirement {
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.category = config.category;
    this.description = config.description;
    this.whyRequired = config.whyRequired;
    this.severity = config.severity;
    this.check = config.check; // async function returning { status, details }
    this.install = config.install || null; // async function returning { success, error }
    this.verify = config.verify || null; // async function returning { success, error }
    this.bypassAllowed = config.bypassAllowed || false;
    this.dependencies = config.dependencies || []; // Array of Requirement IDs
    this.affects = config.affects || []; // Array of CAPABILITIES
    this.status = STATUS.NOT_CHECKED;
    this.details = null;
  }
}

class ModelDefinition {
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.type = config.type; // llm, tts, image, video, transcribe
    this.local = config.local !== false; // default true
    this.requirements = config.requirements || []; // Expected resources
    this.runtime = config.runtime || 'native'; 
    this.downloadSize = config.downloadSize || 'Unknown';
    this.estimatedVram = config.estimatedVram || 'Unknown';
    this.status = STATUS.NOT_CHECKED;
  }
}

const requirementsRegistry = new Map();
const modelRegistry = new Map();

function registerRequirement(config) {
  const req = new Requirement(config);
  requirementsRegistry.set(req.id, req);
  return req;
}

function registerModel(config) {
  const model = new ModelDefinition(config);
  modelRegistry.set(model.id, model);
  return model;
}

function getRequirement(id) {
  return requirementsRegistry.get(id);
}

function getModel(id) {
  return modelRegistry.get(id);
}

function getAllRequirements() {
  return Array.from(requirementsRegistry.values());
}

function getAllModels() {
  return Array.from(modelRegistry.values());
}

module.exports = {
  Requirement,
  ModelDefinition,
  registerRequirement,
  registerModel,
  getRequirement,
  getModel,
  getAllRequirements,
  getAllModels
};
