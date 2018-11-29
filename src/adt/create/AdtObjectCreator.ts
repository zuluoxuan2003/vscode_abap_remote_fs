import { Uri, window } from "vscode"
import { parsetoPromise, getNode, recxml2js } from "../AdtParserBase"
import { mapWith } from "../../functions"
import { AdtServer } from "../AdtServer"
import { isAbapNode, AbapNode } from "../../fs/AbapNode"
import {
  selectObjectType,
  ObjectType,
  NewObjectConfig,
  getObjectType,
  PACKAGE
} from "./AdtObjectTypes"
import { selectTransport } from "../AdtTransports"
import { abapObjectFromNode } from "../../abap/AbapObjectUtilities"

interface ValidationMessage {
  SEVERITY: string
  SHORT_TEXT: string
  LONG_TEXT: string
}

interface AdtObjectType {
  OBJECT_TYPE: string
  OBJECT_TYPE_LABEL: string
  CATEGORY: string
  CATEGORY_LABEL: string
  URI_TEMPLATE: string
  PARENT_OBJECT_TYPE: string
  OBJNAME_MAXLENGTH: string
  canCreate: boolean
}
export class AdtObjectCreator {
  private types?: AdtObjectType[]

  constructor(private server: AdtServer) {}

  async loadTypes(): Promise<AdtObjectType[]> {
    const uri = this.server.connection.createUri(
      "/sap/bc/adt/repository/typestructure"
    )
    const response = await this.server.connection.request(uri, "POST")
    const raw = await parsetoPromise()(response.body)
    return getNode(
      "asx:abap/asx:values/DATA/SEU_ADT_OBJECT_TYPE_DESCRIPTOR",
      mapWith(recxml2js),
      (typedescs: any[]) => typedescs.filter(td => td.CAPABILITIES !== ""),
      mapWith(x => {
        const { CAPABILITIES, ...rest } = x
        const canCreate = !!CAPABILITIES.SEU_ACTION.find(
          (x: any) => x === "CREATE"
        )
        return { ...rest, canCreate }
      }),
      raw
    )
  }

  async getObjectTypes(uri: Uri): Promise<AdtObjectType[]> {
    if (!this.types) this.types = await this.loadTypes()
    const parent = this.server.findNode(uri)
    let otype = parent && isAbapNode(parent) && parent.abapObject.type
    if (otype === PACKAGE) otype = ""
    return this.types!.filter(x => x.PARENT_OBJECT_TYPE === otype)
  }

  private getHierarchy(uri: Uri | undefined): AbapNode[] {
    if (uri)
      try {
        return this.server.findNodeHierarcy(uri)
      } catch (e) {}
    return []
  }

  private async guessOrSelectObjectType(
    hierarchy: AbapNode[]
  ): Promise<ObjectType | undefined> {
    //TODO: guess from URI
    const base = hierarchy[0]
    //if I picked the root node,a direct descendent or a package just ask the user to select any object type
    // if not, for abap nodes pick child objetc types (if any)
    // for non-abap nodes if it's an object type guess the type from the children
    if (hierarchy.length > 2)
      if (isAbapNode(base)) return selectObjectType(base.abapObject.type)
      else {
        const child = [...base]
          .map(c => c[1])
          .find(c => isAbapNode(c) && c.abapObject.type !== PACKAGE)
        if (child && isAbapNode(child)) {
          const guessed = getObjectType(child.abapObject.type)
          if (guessed) return guessed
        }
      }
    //default...
    return selectObjectType()
  }

  private async validateObject(
    objType: ObjectType,
    objDetails: NewObjectConfig
  ): Promise<ValidationMessage[]> {
    const url = this.server.connection.createUri(
      objType.getValidatePath(objDetails)
    )
    const response = await this.server.connection.request(url, "POST")
    const rawValidation = await parsetoPromise()(response.body)
    return getNode(
      "asx:abap/asx:values/DATA",
      mapWith(recxml2js),
      rawValidation
    ) as ValidationMessage[]
  }

  /**
   * Finds or ask the user to select/create a transport for an object.
   * Returns an empty string for local objects
   *
   * @param objType Object type
   * @param objDetails Object name, description,...
   */
  private async selectTransport(
    objType: ObjectType,
    objDetails: NewObjectConfig
  ): Promise<string> {
    //TODO: no request for temp packages
    const uri = this.server.connection.createUri(objType.getPath(objDetails))
    return selectTransport(uri, objDetails.devclass, this.server.connection)
  }
  /**
   * Creates an ABAP object
   *
   * @param objType Object type descriptor
   * @param objDetails Object details (name, description, package,...)
   * @param request Transport request
   */
  private async create(
    objType: ObjectType,
    objDetails: NewObjectConfig,
    request: string
  ) {
    const uri = this.server.connection.createUri(
      objType.getBasePath(objDetails)
    )
    let body = objType.getCreatePayload(objDetails)
    const query = request ? `corrNr=${request}` : ""
    //TODO hack for cache invalidation, need to find a proper solution
    this.server.connection.stateful = false
    let response = await this.server.connection.request(uri, "POST", {
      body,
      query
    })
    this.server.connection.stateful = true
    return response
  }
  private async askInput(
    prompt: string,
    uppercase: boolean = true
  ): Promise<string> {
    const res = (await window.showInputBox({ prompt })) || ""
    return uppercase ? res.toUpperCase() : res
  }

  /**
   * Creates an ABAP object asking the user for unknown details
   * Tries to guess object type and parent/package from URI
   *
   * @param uri Creates an ABAP object
   */
  async createObject(uri: Uri | undefined) {
    const hierarchy = this.getHierarchy(uri)
    let devclass: string = this.guessParentByType(hierarchy, PACKAGE)
    const objType = await this.guessOrSelectObjectType(hierarchy)
    //user didn't pick one...
    if (!objType) return
    const name = await this.askInput("name")
    if (!name) return
    const description = await this.askInput("description", false)
    if (!description) return
    let parentName
    if (objType.parentType === PACKAGE) parentName = devclass
    else
      parentName =
        this.guessParentByType(hierarchy, objType.parentType) ||
        (await this.askInput("parent"))
    if (!parentName) return

    if (!devclass) devclass = await this.askInput("Package")
    if (!devclass) return
    if (objType.parentType === PACKAGE) parentName = devclass
    const objDetails: NewObjectConfig = {
      description,
      devclass,
      parentName: parentName || "",
      name
    }
    const valresult = await this.validateObject(objType, objDetails)
    const err =
      valresult.length > 0 && valresult.find(x => x.SEVERITY === "ERROR")
    if (err) throw new Error(err.SHORT_TEXT)

    const trnumber = await this.selectTransport(objType, objDetails)

    await this.create(objType, objDetails, trnumber) //exceptions will bubble up
    const obj = abapObjectFromNode(objType.objNode(objDetails))
    await obj.loadMetadata(this.server.connection)
    return objType.getPath(objDetails)
  }
  guessParentByType(hierarchy: AbapNode[], type: string): string {
    //find latest package parent
    const pn = hierarchy.find(n => isAbapNode(n) && n.abapObject.type === type)
    //return package name or blank string
    return (pn && isAbapNode(pn) && pn.abapObject.name) || ""
  }
}
