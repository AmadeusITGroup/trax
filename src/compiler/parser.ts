import { TraxImport, DataObject, DataProperty, DataType } from './types';
import * as ts from "typescript";

const DATA = "Data", REF = "ref";

export function parse(src: string, filePath: string): (TraxImport | DataObject)[] | null {
    let srcFile = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, /*setParentNodes */ true);
    let traxImportFound = false, result: (TraxImport | DataObject)[] | null = [];

    let diagnostics = srcFile['parseDiagnostics'];
    if (diagnostics && diagnostics.length) {
        let d: ts.Diagnostic = diagnostics[0] as any;
        // TODO
        // this.logError("TypeScript parsing error: " + d.messageText.toString(), d.start || 0)
        result = null;
    } else {
        // process all parts
        scan(srcFile);
    }

    return result;

    function error(message: string, node: ts.Node) {
        // TODO
        throw new Error(message + " at pos: " + node.pos);
    }

    function scan(node: ts.Node) {
        if (processNode(node)) {
            ts.forEachChild(node, scan);
        }
    }

    function processNode(node: ts.Node): boolean {
        if (!result) return false;

        if (node.kind === ts.SyntaxKind.ImportClause) {
            processImport(node as ts.ImportClause);
            return false;
        } else if (node.kind === ts.SyntaxKind.ClassDeclaration) {
            processClass(node as ts.ClassDeclaration);
            return false;
        } else {
            //console.log("Node: ", node.kind)
            //debugger
        }

        return true;
    }

    function processImport(node: ts.ImportClause) {
        if (traxImportFound) return;
        if (node.namedBindings) {
            let nmi = <ts.NamedImports>node.namedBindings;
            if (nmi.elements) {
                let idx = nmi.elements.length, traxImport: TraxImport | undefined;
                while (idx--) {
                    if (nmi.elements[idx].name.text === DATA) {
                        traxImport = {
                            insertPos: nmi.elements[idx].end,
                            values: {}
                        }
                        break;
                    }
                }
                if (traxImport) {
                    traxImportFound = true;
                    idx = nmi.elements.length;
                    while (idx--) {
                        traxImport.values[nmi.elements[idx].name.text] = 1
                    }
                    result!.push(traxImport);
                }
            }
        }
    }

    function processClass(node: ts.ClassDeclaration) {
        let isData = false;
        if (node.decorators) {
            let decorators = node.decorators, idx = decorators.length, d: ts.Decorator;
            while (idx--) {
                d = decorators[idx];
                if (d.expression.kind === ts.SyntaxKind.Identifier && d.expression.getText() === DATA) {
                    isData = true;
                    // comment the dataset expression to remove it from generated code (and don't impact line numbers)
                    // this.insert("/* ", d.expression.pos - 1);
                    // this.insert(" */", d.expression.end);
                    break;
                }
            }
        }
        if (!isData) return;

        if (!node.name) {
            error("Data class name must be defined", node);
        }

        let obj: DataObject = {
            pos: node.pos,
            className: node.name!.text,
            classNameEnd: node.name!.end,
            properties: [],
            computedProperties: []
        }

        if (node.members) {
            let members = node.members, name, isSimpleType = false, processedPropData: [string, string] | null, typeName: string, canBeUndefined: boolean;
            for (let i = 0, len = members.length; len > i; i++) {
                isSimpleType = false;
                canBeUndefined = false;
                typeName = "";
                let m = members[i];
                // processedPropData = this.processProcessorDecorator(m);

                if (m.kind === ts.SyntaxKind.Constructor) {
                    error("Constructors are not authorized in Data objects", m);
                } else if (m.kind !== ts.SyntaxKind.PropertyDeclaration) {
                    error("Invalid Data object member [kind: " + m.kind + "]", m);
                }

                // add $$ in front of the property name
                let prop: DataProperty = {
                    name: "",
                    end: 0,
                    shallowRef: hasRefDecorator(m),
                    type: undefined,
                    defaultValue: undefined
                }
                m.forEachChild((c) => {
                    if (c.kind === ts.SyntaxKind.Identifier) {
                        prop.name = c.getText();
                        prop.end = c.end;
                    } else {
                        let tp = getTypeObject(c, false);
                        if (tp) {
                            prop.type = tp;
                        } else if (!handleDefaultValue(c, prop) && c.kind !== ts.SyntaxKind.Decorator) {
                            error("Unsupported syntax", c);
                        }
                    }
                });
                obj.properties.push(prop);

                // if (processedPropData) {
                //     processedProps.push(name);

                //     // close comment and add new getter
                //     this.insert([
                //         " */ get ", name, "() ",
                //         "{return __h.retrieve(this, ", processedPropData[0], ", \"$$", name, "\"", processedPropData[1], ")}"
                //     ].join(''), m.end);;

                // } else {
                //     if (isSimpleType) {
                //         simpleTypeProps.push(name);
                //     } else if (typeName) {
                //         dataNodeProps.push(name);
                //     } else {
                //         // todo
                //         this.logError("Invalid property type", m.pos);
                //     }

                //     this.insert(getGetterAndSetter(getSeparator(m), name, typeName, canBeUndefined), m.end);
                // }
            }
        }

        result!.push(obj);
    }

    function hasRefDecorator(m: ts.ClassElement): boolean {
        if (m.decorators) {
            let decorators = m.decorators, idx = decorators.length, d: ts.Decorator;
            while (idx--) {
                d = decorators[idx];
                let e = d.expression;
                if (e.getText() === REF) return true
            }
        }
        return false;
    }

    function getTypeObject(n: ts.Node, raiseErrorIfInvalid = false): DataType | null {
        if (n) {
            if (n.kind === ts.SyntaxKind.StringKeyword) {
                return { kind: "string" }
            } else if (n.kind === ts.SyntaxKind.BooleanKeyword) {
                return { kind: "boolean" }
            } else if (n.kind === ts.SyntaxKind.NumberKeyword) {
                return { kind: "number" }
            } else if (n.kind === ts.SyntaxKind.TypeReference) {
                return {
                    kind: "reference",
                    identifier: n.getText()
                }
            } else if (n.kind === ts.SyntaxKind.ArrayType) {
                return {
                    kind: "array",
                    itemType: getTypeObject(n["elementType"], true) as any
                }
            } else if (n.kind === ts.SyntaxKind.TypeLiteral) {
                // expected to be something like dict: { [key: string]: Address }
                let members = (n as ts.TypeLiteralNode).members;
                if (members && members.length === 1 && members[0].kind === ts.SyntaxKind.IndexSignature) {
                    let idxSignature = members[0] as ts.IndexSignatureDeclaration, parameters = idxSignature.parameters;
                    if (parameters && parameters.length === 1) {
                        let tp = getTypeObject(parameters[0].type!);
                        return {
                            kind: "dictionary",
                            itemType: tp!
                        }
                    }
                }
            }
        }
        // else if (c.kind === ts.SyntaxKind.UnionType) {
        //     // types should be either undefined or DataNode types
        //     let ut = <ts.UnionTypeNode>c;
        //     if (ut.types) {
        //         let idx = ut.types.length;
        //         while (idx--) {
        //             let tp = ut.types[idx];
        //             if (tp.kind === ts.SyntaxKind.TypeReference) {
        //                 typeName = tp.getText();
        //             } else if (tp.kind === ts.SyntaxKind.UndefinedKeyword) {
        //                 canBeUndefined = true;
        //             } else if (tp.kind !== ts.SyntaxKind.NullKeyword) {
        //                 this.logError("Invalid property type", tp.pos);
        //             }
        //         }
        //     }
        // }
        if (raiseErrorIfInvalid && n.kind !== ts.SyntaxKind.Decorator) {
            // console.log("Unsupported type", n)
            error("Unsupported type", n);
        }
        return null;
    }

    function handleDefaultValue(n: ts.Node, prop: DataProperty): boolean {
        if (n) {
            let v: string = "", kind = "";
            if (n.kind === ts.SyntaxKind.StringLiteral) {
                kind = "string";
            } else if (n.kind === ts.SyntaxKind.NumericLiteral) {
                kind = "number";
            } else if (n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword) {
                kind = "boolean";
            }
            if (kind !== "") {
                prop.defaultValue = {
                    pos: n.pos,
                    end: n.end,
                    text: n.getFullText()
                }
                if (!prop.type) {
                    prop.type = {
                        kind: kind as any
                    }
                }
                return true;
            }
        }
        return false;
    }
}
