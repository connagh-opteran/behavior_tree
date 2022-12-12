//@ts-check

// Node states
const FAILED = 0,
      SUCCESS = 1,
      RUNNING = 2;

// Node kinds
const FALLBACK = 'fallback',
      SEQUENCE = 'sequence',
      PARALLEL = 'parallel',
      ACTION = 'action',
      CONDITION = 'condition';

function expect(what, have) {
    return `Expecting '${what}', have '${have}'`;
}

/**
 * Parses _sequence_ node from current position in the buffer
 * @param {string} buf behavior tree model
 * @param {number} i current index
 * @returns {[number, string | null]} tuple with adjusted current parsing index and error message or null
 */
function parseSequence(buf, i) {
    if (i < buf.length) {
        let ch = buf[i];
        if (ch == '>') {
            i++;
            return [i, null];
        } else {
            return [i, expect('>', ch)];
        }
    } else {
        return [i, expect('>', 'EOF')];
    }
}

/**
 * Parses _condition_ node from current position in the buffer
 * @param {string} buf input buffer
 * @param {number} i position in input buffer
 * @returns {[number, string, string | null]} tuple with adjusted current parsing index, actual string and expected string
 */
function parseCondition(buf, i) {
    let cond = '';
    while (i < buf.length) {
        let ch = buf[i];
        i++;
        if (ch == ')') {
            return [i, cond.trim(), null];
        } else {
            cond = cond.concat(ch);
        }
    }
    return [i, cond, expect(')', 'EOF')];
}

/**
 * Parses _action_ node from current position in the buffer
 * @param {string} buf input buffer
 * @param {number} i position in input buffer
 * @returns {[number, string, string | null]} tuple with adjusted current parsing index, actual string and expected string
 */
function parseAction(buf, i) {
    let action = '';
    while (i < buf.length) {
        let ch = buf[i];
        i++;
        if (ch == ']') {
            return [i, action.trim(), null];
        } else {
            action = action.concat(ch);
        }
    }
    return [i, action, expect(']', 'EOF')];
}

/**
 * Parses _parallel_ node from current position in the buffer
 * @param {string} buf input buffer
 * @param {number} i position in input buffer
 * @returns {[number, number, string | null]} tuple with parallel success branch count, adjusted current parsing index and error message or undefined
 */
function parseParallel(buf, i) {
    let numBuf = '';
    while (i < buf.length) {
        let ch = buf[i];
        let m = ch.match(/\d/);
        if (m && m.length == 1) {
            numBuf += ch;
        } else {
            break;
        }
        i++;
    }
    if (numBuf === '') {
        return [0, i, 'Expecting number after parallel node.'];
    }
    let num = parseInt(numBuf);
    if (num === 0) {
        return [0, i, 'Parallel node must allow at least one child.'];
    }
    return [num, i, null];
}

class Node {
    /**
     * Creates node.
     * @param {string} name node name
     * @param {string} kind node kind
     * @param {Node[] | undefined} children children nodes
     */
    constructor(name, kind, children=undefined) {
        /** @property {string} node name. */
        this.name = name;
        /** @property {string} kind kid such as "fallback". */
        this.kind = kind;
        /** @property {Node[] | undefined} children children nodes. */
        this.children = children || null;
        this._active = false;
        this.wasActive = false; // this does not seem to be used
        this.nodeStatus = FAILED;
        this.hasNot = false;
        this.isSubtree = false;
    }
    status() {
        if (this.hasNot) {
            switch (this.nodeStatus) {
                case SUCCESS: return FAILED;
                case FAILED: return SUCCESS;
            }
        }
        return this.nodeStatus;
    }
    /** @param {number} newStatus */
    setStatus(newStatus) {
        this.nodeStatus = newStatus;
    }
    /** @returns {boolean} true if node is active*/
    active() {
        return this._active;
    }
    /** @param {boolean} isActive */
    setActive(isActive) {
        let previouslyActive = this._active;
        this._active = isActive;
        // was previously active and now it no longer is
        if (previouslyActive && !isActive) {
            this.wasActive = true;
        }
    }
    tick() {
        this.setActive(true);
        return this.status();
    }
    deactivate() {
        this.setActive(false);
        if (this.children) {
            for (let i = 0; i < this.children.length; i++) {
                this.children[i].deactivate();
            }
        }
    }
}

/**
 * Creates fallback node.
 * @param {Node[]} children
 */
function fallback(name = '', children = []) {
    return new Fallback(name, children);
}

class Fallback extends Node {
    /**
     * Creates fallback node.
     * @param {Node[]} children
     */
    constructor(name = '', children = []) {
        super(name, FALLBACK, children || []);
    }
    tick() {
        this.setActive(true);
        for (let i = 0; i < this.children.length; i++) {
            let s = this.children[i].tick();
            this.setStatus(s);
            if (s == RUNNING || s == SUCCESS) {
                return this.status();
            }
        }
        this.setStatus(FAILED);
        return this.status();
    }
}

/**
 * Creates fallback node.
 * @param {Node[]} children
 */
function sequence(name = '', children = []) {
    return new Sequence(name , children);
}

class Sequence extends Node {
    /**
     * Creates fallback node.
     * @param {Node[]} children
     */
    constructor(name = '', children = []) {
        super(name, SEQUENCE, children);
    }
    tick() {
        this.setActive(true);
        for (let i = 0; i < this.children.length; i++) {
            let s = this.children[i].tick();
            this.setStatus(s);
            if (s == RUNNING || s == FAILED) {
                return this.status();
            }
        }
        this.setStatus(SUCCESS);
        return this.status();
    }
}


/**
 * Creates fallback node.
 * @param {number} successCount minimal number of children necessary for the state to be SUCCESS
 * @param {Node[]} children
 */
function parallel(successCount, children = []) {
    return new Parallel(successCount, children);
}

class Parallel extends Node {
    /**
     * Creates Parallel node
     * @param {number} successCount minimal number of children necessary for the state to be SUCCESS
     * @param {Node[]} children
     */
    constructor(name, successCount, children = []) {
        super(name, PARALLEL, children || []);
        this.successCount = successCount;
    }
    tick() {
        this.setActive(true);

        let succeeded = 0,
            failed    = 0,
            kidCount  = this.children.length;

        for (let i = 0; i < this.children.length; i++) {
            let s = this.children[i].tick();
            if (s == SUCCESS) {
                succeeded++;
            }
            if (s == FAILED) {
                failed++;
            }
        }

        let st = RUNNING;
        if (succeeded >= this.successCount) {
            st = SUCCESS;
        } else if (failed > kidCount - this.successCount) {
            st = FAILED;
        }
        this.setStatus(st);
        return st;
    }
}

/**
 * @typedef {(action: Action) => void} ActionActivationCallback Callback called upon action activation
 */

/**
 * Creates action node.
 * @param {string} name action name
 * @param {ActionActivationCallback | undefined} onActivation action activation callback
 * @param {number} status node status
 */
function action(name, onActivation=undefined, status=RUNNING, isSubtree=undefined) {
    return new Action(name, onActivation, status, isSubtree);
}

class Action extends Node {

    /**
     * Creates Action node.
     * @param {string} name action name
     * @param {ActionActivationCallback} onActivation on action
     * @param {number} status initial action status
     */
    constructor(name, onActivation = undefined, status = RUNNING, isSubtree=undefined) {
        super(name, ACTION);
        /** @property {Array<ActionActivationCallback>} action activation callbacks. */
        this.actionActivationCallback = new Array();
        if (onActivation) {
            this.actionActivationCallback.push(onActivation);
        }
        if(isSubtree){
            this.isSubtree = isSubtree;
        }

        this.setStatus(status);
    }

    /**
     * Adds action activation callback.
     * @param {ActionActivationCallback} callback action activation callback
     */
    onActivation(callback) {
        this.actionActivationCallback.push(callback);
    }

    /** @param {boolean} isActive */
    setActive(isActive) {
        super.setActive(isActive);
        this.actionActivationCallback.forEach(c => c(this));
    }
}

/**
 * Creates condition.
 * @param {string} name condition name
 * @param {boolean} hasNot condition negation flag
 * @param {number} status initial condition status
 */
function condition(name, hasNot, status = FAILED) {
    return new Condition(name, hasNot, status);
}

class Condition extends Node {
    /**
     * Creates Condition node.
     * @param {string} name condition name
     * @param {boolean} hasNot is used as negated in the tree
     * @param {number} status initial status
     */
    constructor(name, hasNot, status = FAILED) {
        super(name, CONDITION);
        this.hasNot = hasNot; // ensure the property is declared in both cases
        this.setStatus(status);
    }
}

class BehaviorTree {

    /**
     * Behavior Tree
     * @param {Node} root tree root node
     * @param {number|null} line line at which the error ocurred
     * @param {string|null} error parsing error
     */
    constructor(root, line = null, error = null) {
        /** @property {Node} root node. */
        this.root = root;
        /** @property {Map<string, Action[]>} actions list of actions grouped by name */
        this.actions = new Map();
        /** @property {Map<string, Condition[]>} conditions list of conditions grouped by name */
        this.conditions = new Map();
        this.line = line;
        this.error = error;

        if (this.root) {
            this.extractActionsAndConditions(this.root);
        }

        /** @property {Array<ActionActivationCallback>} actionActivationCallbacks callbacks for action activations in this tree. */
        this.actionActivationCallbacks = new Array();
        let thisTree = this;
        /** @property {ActionActivationCallback} onAnyActionActivation callbacks for action activations in this tree. */
        this.onAnyActionActivation = function (/** @type {Action} */ actionNode) {
            thisTree.actionActivationCallbacks.forEach(callback => callback(actionNode));
        }
        // subscribe to all action nodes in this tree activations
        this.actions.forEach(actions => actions.forEach(a => a.onActivation(this.onAnyActionActivation)));
        this._id = 0;
    }

    /** @param {number} id tree ID tag */
    setId(id) {
        this._id = id;
    }

    /** @returns {number} tree ID tag */
    getId() {
        return this._id;
    }

    /**
     * Recursively extracts action and condition nodes from the sub-tree.
     * @param {Node} node tree node
     * @returns {void}
     */
    extractActionsAndConditions(node) {
        if (node instanceof Action) {
            addToArrayMap(this.actions, node.name, node);
        } else if (node instanceof Condition) {
            addToArrayMap(this.conditions, node.name, node);
        }
        if (node.children) {
            node.children.forEach(c => this.extractActionsAndConditions(c));
        }
    }

    /**
     * Updates tree with new condition value.
     * @param {string} name condition name
     * @param {number} status new status
     */
    setConditionStatus(name, status) {
        if (this.conditions.has(name)) {
            this.conditions.get(name).forEach((/** @type {Condition} */ c) => c.setStatus(status));
        }
    }

    /**
     * Updates tree with new action status.
     * @param {string} name action name
     * @param {number} status new status
     */
    setActionStatus(name, status) {
        if (this.actions.has(name)) {
            this.actions.get(name).forEach((/** @type {Action} */ a) => a.setStatus(status));
        }
    }

    /**
     * Subscribe to action activation events.
     * @param {ActionActivationCallback} callback action activation callback
     */
    onActionActivation(callback) {
        this.actionActivationCallbacks.push(callback);
    }

    /**
     * Re-builds the behavior tree from JSON e.g. after it has been loaded from a file, or transferred via http.
     * @param {any} treeAsJson behavior tree in a JSON form
     * @returns {BehaviorTree}
     */
    static fromJson(treeAsJson) {
        let rootNode = BehaviorTree.nodeFromJson(treeAsJson.root);
        return new BehaviorTree(rootNode, treeAsJson.line, treeAsJson.error);
    }

    /**
     * Re-builds tree node.
     * @param {any} nodeAsJson node in plain JSON form
     */
    static nodeFromJson(nodeAsJson) {
        let node;
        switch (nodeAsJson.kind) {
            case FALLBACK:
                node = fallback((nodeAsJson.name&& nodeAsJson.name != '')? nodeAsJson.name : '?' );
                break;
            case SEQUENCE:
                node = sequence((nodeAsJson.name&& nodeAsJson.name != '')? nodeAsJson.name : '\u2192');
                break;
            case PARALLEL:
                node = parallel((nodeAsJson.name&& nodeAsJson.name != '')? nodeAsJson.name : '\u21C9', nodeAsJson.successCount);
                break;
            case ACTION:
                node = action(nodeAsJson.name, undefined, nodeAsJson.nodeStatus, nodeAsJson.isSubtree);
                break;
            case CONDITION:
                node = condition(nodeAsJson.name, nodeAsJson.hasNot, nodeAsJson.nodeStatus);
                break;
            default:
                throw new Error(`Unexpected node kind: ${nodeAsJson.kind}.`);
        }

        if (nodeAsJson.children) {
            node.children = nodeAsJson.children.map(child => this.nodeFromJson(child));
        }

        return node;
    }

    /**
     * Parses behavior tree from text.
     * @param {string} treeAsText behavior tree textual spec
     */
    static fromText(treeAsText) {
        return parse(treeAsText);
    }

    tick() {
        if (this.root) {
            this.root.tick();
        }
    }
}

/**
 * Parser
 * @param {string} buf behavior tree as text
 * @returns {BehaviorTree}
 */
function parse(buf) {
    let indent     = 0,     // current recorded indentation
        line       = 1,     // line number in text
        notPending = false, // is 'not' decorator waiting to be applied?
        i          = 0;

    /** @type {Node[]} nodes in the current tree branch */
    let nodes = [null];

    /**
     * @param {Node} node tree node being pushed to current tree branch
     * @returns {string|null} error or `null`
     */
    function pushNode(node) {
        if (indent === 0 && nodes[indent]) {
            return `More than one root node or node '${node.name}' has wrong indentation.`;
        }
        if (indent > 0) {
            let parent = nodes[indent - 1];
            if (!parent) {
                return `${node.name} node has no parent (wrong indentation level)`;
            }
            if (parent.children) {
                parent.children.push(node);
                nodes[indent] = node;
            } else {
                return `${parent.kind} node can't have child nodes`;
            }
        } else {
            nodes[indent] = node;
        }
        indent++; // nested child on the same line should be indented
        return null; // no error to be reported
    };

    function onError(err) {
        return new BehaviorTree(null, line, err);
    }

    while (i < buf.length) {
        let ch     = buf[i],
            notNow = false;
        i++;

        switch (ch) {
        case ' ':
        case '\t':
            break;

        case '\r': {
            if (i < buf.length && buf[i] === '\n') {
                i += 1;
            }
            line++;
            indent = 0;
        } break;

        case '\n': {
            line++;
            indent = 0;
        } break;

        case '|': {
            indent++;
        } break;

        case '!': {
            if (notPending) {
                // Not operator cancels itself out.
                notPending = false;
            } else {
                notNow = true;
                notPending = true;
            }
        } break;

        case '=': {
            let [num, n, err] = parseParallel(buf, i);
            if (err) {
                return onError(err);
            }
            i = n;
            let p = parallel(num);
            let e = pushNode(p);
            if (e) {
                return onError(e);
            }
        } break;

        case '?': {
            let err = pushNode(fallback());
            if (err) {
                return onError(err);
            }
        } break;

        case '-': {
            let [n, err] = parseSequence(buf, i);
            if (err) {
                return onError(err);
            }
            i = n;
            let e = pushNode(sequence());
            if (e) {
                return onError(e);
            }
        } break;

        case '(': {
            let [n, name, err] = parseCondition(buf, i);
            if (err) {
                return onError(err);
            }
            i = n;
            let c = condition(name, notPending);
            if (notPending) {
                notPending = false;
            }
            let e = pushNode(c);
            if (e) {
                return onError(e);
            }
        } break;

        case '[': {
            let [n, name, err] = parseAction(buf, i);
            if (err) {
                return onError(err);
            }
            i = n;
            let a = action(name);
            let e = pushNode(a);
            if (e) {
                return onError(e);
            }
        } break;

        default:
            let err = `Expecting '|', '-', '!', '[', or '(' but have '${ch}'`;
            return onError(err);
        }

        if (!notNow && notPending) {
            let err = 'Not operator can only be applied to conditions';
            return onError(err);
        }
        notNow = false;
    }
    if (!nodes[0]) {
        let e = 'Tree must have at least one node but has none';
        return onError(e);
    }

    return new BehaviorTree(nodes[0], line, null);
}

/**
 * 
 * @param {Map<string, Node[]>} map map to insert to
 * @param {string} key map key
 * @param {Node} value value to insert for the given _key_
 */
function addToArrayMap(map, key, value) {
    if (map.has(key)) {
        map.get(key).push(value);
    } else {
        map.set(key, [value]);
    }
}

const SAMPLE_TREE = `
?
|    ->
|    |    (Ghost Close)
|    |    ?
|    |    |    ->
|    |    |    |    !(Ghost Scared)
|    |    |    |    (Power Pill Close)
|    |    |    |    [Eat Power Pill]
|    |    |    ->
|    |    |    |    (Ghost Scared)
|    |    |    |    [Chase Ghost]
|    |    |    [Avoid Ghost]
|    =1
|    |    [Eat Pills]
|    |    [Eat Fruit]
`;

/**
 * Gets friendly status
 * @param {number} status tree node status
 * @returns {string} user-friendly status string
 */
function getFriendlyStatus(status) {
    switch (status) {
        case FAILED:
            return 'Failed';
        case SUCCESS:
            return 'Success';
        case RUNNING:
            return 'Running';
        default:
            return 'Unknown';
    }
}

/**
 * Returns turns the parsed xml in a format that can be fed to nodeFromJson
 * @param {*} xml_string 
 * @returns 
 */
function parse_xml(xml_string) {
    let parser = new DOMParser();
    let xmlDom = parser.parseFromString(xml_string, 'text/xml');
    let bt_xml = xmlDom.querySelector('BehaviorTree');
    if(bt_xml.children.length != 1) {
        console.log("INVALID XML")
        return null;
    }
    else {
        let bt_obj = recurse_build_obj(bt_xml.children[0]);
        
        return {root: bt_obj, line:null, error: null};
    }
    
}

/**
 * Returns a json object describing the xml
 * 
 * Currently automaticall collapses the Inverter decorator
 * @param {*} node 
 * @returns 
 */
function recurse_build_obj(node){
    var node_obj = {children: []};
    let node_name = node.nodeName;
    node_obj['nodeStatus'] = 2;
    switch(node_name.toLowerCase()) {
        case "sequence":
            node_obj['kind'] = "sequence";
            node_obj['name'] = node.getAttribute('name');
            node_obj['hasNot'] = false;
            break;
        case "parallel":
            break; // TODO: IMPLEMENT
        case "fallback":
            node_obj['kind'] = "fallback";
            node_obj['name'] = node.getAttribute('name');
            node_obj['hasNot'] = false;
            break;
        case "decorator":    // This wont work 
            node_obj['kind'] = "decorator";
            node_obj['name'] = node.getAttribute('name');
            node_obj['hasNot'] = false;
            break;
        case "action":
            node_obj['kind'] = "action";
            node_obj['name'] = node.getAttribute('ID');
            node_obj['hasNot'] = false;
            break;
        case "condition":
            node_obj['kind'] = "condition";
            node_obj['name'] = node.getAttribute('ID');
            node_obj['hasNot'] = false;
            node_obj['nodeStatus'] = 0;
            break;
        case "inverter":
            node = node.children[0]
            node_obj = recurse_build_obj(node);
            node_obj['hasNot'] = true;
            return node_obj;
        case "subtree": // Subtree is currently just an 'action' and most be viewed seperatly
            node_obj['kind'] = "action";
            node_obj['name'] = node.getAttribute('ID');
            node_obj['hasNot'] = false;
            node_obj['nodeStatus'] = 0;
            node_obj['isSubtree'] = true;
            break;
        default:
            node_obj['kind'] = "action";
            node_obj['name'] = node_name
            node_obj['hasNot'] = false;
            break;
    }
    for(let child of node.children){
        node_obj.children.push(recurse_build_obj(child))
    }
    return node_obj;

}


if (typeof exports !== 'undefined' && exports) {
    exports.bt = {
        BehaviorTree,
        parse, parse_xml, SUCCESS, FAILED, RUNNING,
        fallback, sequence, parallel, condition, action,
        FALLBACK, SEQUENCE, PARALLEL, CONDITION, ACTION,
        SAMPLE_TREE, getFriendlyStatus
    };
}