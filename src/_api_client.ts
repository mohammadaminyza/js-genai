/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Auth} from './_auth.js';
import * as common from './_common.js';
import {Downloader} from './_downloader.js';
import {Uploader} from './_uploader.js';
import {ApiError} from './errors.js';
import {
  DownloadFileParameters,
  File,
  HttpOptions,
  HttpResponse,
  UploadFileConfig,
} from './types.js';

const CONTENT_TYPE_HEADER = 'Content-Type';
const SERVER_TIMEOUT_HEADER = 'X-Server-Timeout';
const USER_AGENT_HEADER = 'User-Agent';
export const GOOGLE_API_CLIENT_HEADER = 'x-goog-api-client';
export const SDK_VERSION = '1.8.0'; // x-release-please-version
const LIBRARY_LABEL = `google-genai-sdk/${SDK_VERSION}`;
const VERTEX_AI_API_DEFAULT_VERSION = 'v1beta1';
const GOOGLE_AI_API_DEFAULT_VERSION = 'v1beta';
const responseLineRE = /^data: (.*)(?:\n\n|\r\r|\r\n\r\n)/;

/**
 * Options for initializing the ApiClient. The ApiClient uses the parameters
 * for authentication purposes as well as to infer if SDK should send the
 * request to Vertex AI or Gemini API.
 */
export interface ApiClientInitOptions {
  /**
   * The object used for adding authentication headers to API requests.
   */
  auth: Auth;
  /**
   * The uploader to use for uploading files. This field is required for
   * creating a client, will be set through the Node_client or Web_client.
   */
  uploader: Uploader;
  /**
   * Optional. The downloader to use for downloading files. This field is
   * required for creating a client, will be set through the Node_client or
   * Web_client.
   */
  downloader: Downloader;
  /**
   * Optional. The Google Cloud project ID for Vertex AI users.
   * It is not the numeric project name.
   * If not provided, SDK will try to resolve it from runtime environment.
   */
  project?: string;
  /**
   * Optional. The Google Cloud project location for Vertex AI users.
   * If not provided, SDK will try to resolve it from runtime environment.
   */
  location?: string;

  /**
   * The API url. This is required for Gemini API users.
   */
  apiUrl?: string;

  /**
   * The API Key. This is required for Gemini API users.
   */
  apiKey?: string;
  /**
   * Optional. Set to true if you intend to call Vertex AI endpoints.
   * If unset, default SDK behavior is to call Gemini API.
   */
  vertexai?: boolean;
  /**
   * Optional. The API version for the endpoint.
   * If unset, SDK will choose a default api version.
   */
  apiVersion?: string;
  /**
   * Optional. A set of customizable configuration for HTTP requests.
   */
  httpOptions?: HttpOptions;
  /**
   * Optional. An extra string to append at the end of the User-Agent header.
   *
   * This can be used to e.g specify the runtime and its version.
   */
  userAgentExtra?: string;
}

/**
 * Represents the necessary information to send a request to an API endpoint.
 * This interface defines the structure for constructing and executing HTTP
 * requests.
 */
export interface HttpRequest {
  /**
   * URL path from the modules, this path is appended to the base API URL to
   * form the complete request URL.
   *
   * If you wish to set full URL, use httpOptions.baseUrl instead. Example to
   * set full URL in the request:
   *
   * const request: HttpRequest = {
   *   path: '',
   *   httpOptions: {
   *     baseUrl: 'https://<custom-full-url>',
   *     apiVersion: '',
   *   },
   *   httpMethod: 'GET',
   * };
   *
   * The result URL will be: https://<custom-full-url>
   *
   */
  path: string;
  /**
   * Optional query parameters to be appended to the request URL.
   */
  queryParams?: Record<string, string>;
  /**
   * Optional request body in json string or Blob format, GET request doesn't
   * need a request body.
   */
  body?: string | Blob;
  /**
   * The HTTP method to be used for the request.
   */
  httpMethod: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /**
   * Optional set of customizable configuration for HTTP requests.
   */
  httpOptions?: HttpOptions;
  /**
   * Optional abort signal which can be used to cancel the request.
   */
  abortSignal?: AbortSignal;
}

/**
 * The ApiClient class is used to send requests to the Gemini API or Vertex AI
 * endpoints.
 */
export class ApiClient {
  readonly clientOptions: ApiClientInitOptions;

  constructor(opts: ApiClientInitOptions) {
    this.clientOptions = {
      ...opts,
      project: opts.project,
      location: opts.location,
      apiUrl: opts.apiUrl,
      apiKey: opts.apiKey,
      vertexai: opts.vertexai,
    };

    const initHttpOptions: HttpOptions = {};

    if (this.clientOptions.vertexai) {
      initHttpOptions.apiVersion =
        this.clientOptions.apiVersion ?? VERTEX_AI_API_DEFAULT_VERSION;
      initHttpOptions.baseUrl = this.baseUrlFromProjectLocation();
      this.normalizeAuthParameters();
    } else {
      // Gemini API
      initHttpOptions.apiVersion =
        this.clientOptions.apiVersion ?? GOOGLE_AI_API_DEFAULT_VERSION;
      initHttpOptions.baseUrl =
        opts.apiUrl ?? `https://generativelanguage.googleapis.com/`;
    }

    initHttpOptions.headers = this.getDefaultHeaders();

    this.clientOptions.httpOptions = initHttpOptions;

    if (opts.httpOptions) {
      this.clientOptions.httpOptions = this.patchHttpOptions(
        initHttpOptions,
        opts.httpOptions,
      );
    }
  }

  /**
   * Determines the base URL for Vertex AI based on project and location.
   * Uses the global endpoint if location is 'global' or if project/location
   * are not specified (implying API key usage).
   * @private
   */
  private baseUrlFromProjectLocation(): string {
    if (
      this.clientOptions.project &&
      this.clientOptions.location &&
      this.clientOptions.location !== 'global'
    ) {
      // Regional endpoint
      return `https://${this.clientOptions.location}-aiplatform.googleapis.com/`;
    }
    // Global endpoint (covers 'global' location and API key usage)
    return `https://aiplatform.googleapis.com/`;
  }

  /**
   * Normalizes authentication parameters for Vertex AI.
   * If project and location are provided, API key is cleared.
   * If project and location are not provided (implying API key usage),
   * project and location are cleared.
   * @private
   */
  private normalizeAuthParameters(): void {
    if (this.clientOptions.project && this.clientOptions.location) {
      // Using project/location for auth, clear potential API key
      this.clientOptions.apiKey = undefined;
      return;
    }
    // Using API key for auth (or no auth provided yet), clear project/location
    this.clientOptions.project = undefined;
    this.clientOptions.location = undefined;
  }

  isVertexAI(): boolean {
    return this.clientOptions.vertexai ?? false;
  }

  getProject() {
    return this.clientOptions.project;
  }

  getLocation() {
    return this.clientOptions.location;
  }

  getApiVersion() {
    if (
      this.clientOptions.httpOptions &&
      this.clientOptions.httpOptions.apiVersion !== undefined
    ) {
      return this.clientOptions.httpOptions.apiVersion;
    }
    throw new Error('API version is not set.');
  }

  getBaseUrl() {
    if (
      this.clientOptions.httpOptions &&
      this.clientOptions.httpOptions.baseUrl !== undefined
    ) {
      return this.clientOptions.httpOptions.baseUrl;
    }
    throw new Error('Base URL is not set.');
  }

  getRequestUrl() {
    return this.getRequestUrlInternal(this.clientOptions.httpOptions);
  }

  getHeaders() {
    if (
      this.clientOptions.httpOptions &&
      this.clientOptions.httpOptions.headers !== undefined
    ) {
      return this.clientOptions.httpOptions.headers;
    } else {
      throw new Error('Headers are not set.');
    }
  }

  private getRequestUrlInternal(httpOptions?: HttpOptions) {
    if (
      !httpOptions ||
      httpOptions.baseUrl === undefined ||
      httpOptions.apiVersion === undefined
    ) {
      throw new Error('HTTP options are not correctly set.');
    }
    const baseUrl = httpOptions.baseUrl.endsWith('/')
      ? httpOptions.baseUrl.slice(0, -1)
      : httpOptions.baseUrl;
    const urlElement: Array<string> = [baseUrl];
    if (httpOptions.apiVersion && httpOptions.apiVersion !== '') {
      urlElement.push(httpOptions.apiVersion);
    }
    return urlElement.join('/');
  }

  getBaseResourcePath() {
    return `projects/${this.clientOptions.project}/locations/${
      this.clientOptions.location
    }`;
  }

  getApiKey() {
    return this.clientOptions.apiKey;
  }

  getWebsocketBaseUrl() {
    const baseUrl = this.getBaseUrl();
    const urlParts = new URL(baseUrl);
    urlParts.protocol = urlParts.protocol == 'http:' ? 'ws' : 'wss';
    return urlParts.toString();
  }

  setBaseUrl(url: string) {
    if (this.clientOptions.httpOptions) {
      this.clientOptions.httpOptions.baseUrl = url;
    } else {
      throw new Error('HTTP options are not correctly set.');
    }
  }

  private constructUrl(
    path: string,
    httpOptions: HttpOptions,
    prependProjectLocation: boolean,
  ): URL {
    const urlElement: Array<string> = [this.getRequestUrlInternal(httpOptions)];
    if (prependProjectLocation) {
      urlElement.push(this.getBaseResourcePath());
    }
    if (path !== '') {
      urlElement.push(path);
    }
    const url = new URL(`${urlElement.join('/')}`);

    return url;
  }

  private shouldPrependVertexProjectPath(request: HttpRequest): boolean {
    if (this.clientOptions.apiKey) {
      return false;
    }
    if (!this.clientOptions.vertexai) {
      return false;
    }
    if (request.path.startsWith('projects/')) {
      // Assume the path already starts with
      // `projects/<project>/location/<location>`.
      return false;
    }
    if (
      request.httpMethod === 'GET' &&
      request.path.startsWith('publishers/google/models')
    ) {
      // These paths are used by Vertex's models.get and models.list
      // calls. For base models Vertex does not accept a project/location
      // prefix (for tuned model the prefix is required).
      return false;
    }
    return true;
  }

  async request(request: HttpRequest): Promise<HttpResponse> {
    let patchedHttpOptions = this.clientOptions.httpOptions!;
    if (request.httpOptions) {
      patchedHttpOptions = this.patchHttpOptions(
        this.clientOptions.httpOptions!,
        request.httpOptions,
      );
    }

    const prependProjectLocation = this.shouldPrependVertexProjectPath(request);
    const url = this.constructUrl(
      request.path,
      patchedHttpOptions,
      prependProjectLocation,
    );
    if (request.queryParams) {
      for (const [key, value] of Object.entries(request.queryParams)) {
        url.searchParams.append(key, String(value));
      }
    }
    let requestInit: RequestInit = {};
    if (request.httpMethod === 'GET') {
      if (request.body && request.body !== '{}') {
        throw new Error(
          'Request body should be empty for GET request, but got non empty request body',
        );
      }
    } else {
      requestInit.body = request.body;
    }
    requestInit = await this.includeExtraHttpOptionsToRequestInit(
      requestInit,
      patchedHttpOptions,
      request.abortSignal,
    );
    return this.unaryApiCall(url, requestInit, request.httpMethod);
  }

  private patchHttpOptions(
    baseHttpOptions: HttpOptions,
    requestHttpOptions: HttpOptions,
  ): HttpOptions {
    const patchedHttpOptions = JSON.parse(
      JSON.stringify(baseHttpOptions),
    ) as HttpOptions;

    for (const [key, value] of Object.entries(requestHttpOptions)) {
      // Records compile to objects.
      if (typeof value === 'object') {
        // @ts-expect-error TS2345TS7053: Element implicitly has an 'any' type
        // because expression of type 'string' can't be used to index type
        // 'HttpOptions'.
        patchedHttpOptions[key] = {...patchedHttpOptions[key], ...value};
      } else if (value !== undefined) {
        // @ts-expect-error TS2345TS7053: Element implicitly has an 'any' type
        // because expression of type 'string' can't be used to index type
        // 'HttpOptions'.
        patchedHttpOptions[key] = value;
      }
    }
    return patchedHttpOptions;
  }

  async requestStream(
    request: HttpRequest,
  ): Promise<AsyncGenerator<HttpResponse>> {
    let patchedHttpOptions = this.clientOptions.httpOptions!;
    if (request.httpOptions) {
      patchedHttpOptions = this.patchHttpOptions(
        this.clientOptions.httpOptions!,
        request.httpOptions,
      );
    }

    const prependProjectLocation = this.shouldPrependVertexProjectPath(request);
    const url = this.constructUrl(
      request.path,
      patchedHttpOptions,
      prependProjectLocation,
    );
    if (!url.searchParams.has('alt') || url.searchParams.get('alt') !== 'sse') {
      url.searchParams.set('alt', 'sse');
    }
    let requestInit: RequestInit = {};
    requestInit.body = request.body;
    requestInit = await this.includeExtraHttpOptionsToRequestInit(
      requestInit,
      patchedHttpOptions,
      request.abortSignal,
    );
    return this.streamApiCall(url, requestInit, request.httpMethod);
  }

  private async includeExtraHttpOptionsToRequestInit(
    requestInit: RequestInit,
    httpOptions: HttpOptions,
    abortSignal?: AbortSignal,
  ): Promise<RequestInit> {
    if ((httpOptions && httpOptions.timeout) || abortSignal) {
      const abortController = new AbortController();
      const signal = abortController.signal;
      if (httpOptions.timeout && httpOptions?.timeout > 0) {
        setTimeout(() => abortController.abort(), httpOptions.timeout);
      }
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => {
          abortController.abort();
        });
      }
      requestInit.signal = signal;
    }
    if (httpOptions && httpOptions.extraBody !== null) {
      includeExtraBodyToRequestInit(
        requestInit,
        httpOptions.extraBody as Record<string, unknown>,
      );
    }
    requestInit.headers = await this.getHeadersInternal(httpOptions);
    return requestInit;
  }

  private async unaryApiCall(
    url: URL,
    requestInit: RequestInit,
    httpMethod: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  ): Promise<HttpResponse> {
    return this.apiCall(url.toString(), {
      ...requestInit,
      method: httpMethod,
    })
      .then(async (response) => {
        await throwErrorIfNotOK(response);
        return new HttpResponse(response);
      })
      .catch((e) => {
        if (e instanceof Error) {
          throw e;
        } else {
          throw new Error(JSON.stringify(e));
        }
      });
  }

  private async streamApiCall(
    url: URL,
    requestInit: RequestInit,
    httpMethod: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  ): Promise<AsyncGenerator<HttpResponse>> {
    return this.apiCall(url.toString(), {
      ...requestInit,
      method: httpMethod,
    })
      .then(async (response) => {
        await throwErrorIfNotOK(response);
        return this.processStreamResponse(response);
      })
      .catch((e) => {
        if (e instanceof Error) {
          throw e;
        } else {
          throw new Error(JSON.stringify(e));
        }
      });
  }

  async *processStreamResponse(
    response: Response,
  ): AsyncGenerator<HttpResponse> {
    const reader = response?.body?.getReader();
    const decoder = new TextDecoder('utf-8');
    if (!reader) {
      throw new Error('Response body is empty');
    }

    try {
      let buffer = '';
      while (true) {
        const {done, value} = await reader.read();
        if (done) {
          if (buffer.trim().length > 0) {
            throw new Error('Incomplete JSON segment at the end');
          }
          break;
        }
        const chunkString = decoder.decode(value);

        // Parse and throw an error if the chunk contains an error.
        try {
          const chunkJson = JSON.parse(chunkString) as Record<string, unknown>;
          if ('error' in chunkJson) {
            const errorJson = JSON.parse(
              JSON.stringify(chunkJson['error']),
            ) as Record<string, unknown>;
            const status = errorJson['status'] as string;
            const code = errorJson['code'] as number;
            const errorMessage = `got status: ${status}. ${JSON.stringify(
              chunkJson,
            )}`;
            if (code >= 400 && code < 600) {
              const apiError = new ApiError({
                message: errorMessage,
                status: code,
              });
              throw apiError;
            }
          }
        } catch (e: unknown) {
          const error = e as Error;
          if (error.name === 'ApiError') {
            throw e;
          }
        }
        buffer += chunkString;
        let match = buffer.match(responseLineRE);
        while (match) {
          const processedChunkString = match[1];
          try {
            const partialResponse = new Response(processedChunkString, {
              headers: response?.headers,
              status: response?.status,
              statusText: response?.statusText,
            });
            yield new HttpResponse(partialResponse);
            buffer = buffer.slice(match[0].length);
            match = buffer.match(responseLineRE);
          } catch (e) {
            throw new Error(
              `exception parsing stream chunk ${processedChunkString}. ${e}`,
            );
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async apiCall(
    url: string,
    requestInit: RequestInit,
  ): Promise<Response> {
    return fetch(url, requestInit).catch((e) => {
      throw new Error(`exception ${e} sending request`);
    });
  }

  getDefaultHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};

    const versionHeaderValue =
      LIBRARY_LABEL + ' ' + this.clientOptions.userAgentExtra;

    headers[USER_AGENT_HEADER] = versionHeaderValue;
    headers[GOOGLE_API_CLIENT_HEADER] = versionHeaderValue;
    headers[CONTENT_TYPE_HEADER] = 'application/json';

    return headers;
  }

  private async getHeadersInternal(
    httpOptions: HttpOptions | undefined,
  ): Promise<Headers> {
    const headers = new Headers();
    if (httpOptions && httpOptions.headers) {
      for (const [key, value] of Object.entries(httpOptions.headers)) {
        headers.append(key, value);
      }
      // Append a timeout header if it is set, note that the timeout option is
      // in milliseconds but the header is in seconds.
      if (httpOptions.timeout && httpOptions.timeout > 0) {
        headers.append(
          SERVER_TIMEOUT_HEADER,
          String(Math.ceil(httpOptions.timeout / 1000)),
        );
      }
    }
    await this.clientOptions.auth.addAuthHeaders(headers);
    return headers;
  }

  /**
   * Uploads a file asynchronously using Gemini API only, this is not supported
   * in Vertex AI.
   *
   * @param file The string path to the file to be uploaded or a Blob object.
   * @param config Optional parameters specified in the `UploadFileConfig`
   *     interface. @see {@link UploadFileConfig}
   * @return A promise that resolves to a `File` object.
   * @throws An error if called on a Vertex AI client.
   * @throws An error if the `mimeType` is not provided and can not be inferred,
   */
  async uploadFile(
    file: string | Blob,
    config?: UploadFileConfig,
  ): Promise<File> {
    const fileToUpload: File = {};
    if (config != null) {
      fileToUpload.mimeType = config.mimeType;
      fileToUpload.name = config.name;
      fileToUpload.displayName = config.displayName;
    }

    if (fileToUpload.name && !fileToUpload.name.startsWith('files/')) {
      fileToUpload.name = `files/${fileToUpload.name}`;
    }

    const uploader = this.clientOptions.uploader;
    const fileStat = await uploader.stat(file);
    fileToUpload.sizeBytes = String(fileStat.size);
    const mimeType = config?.mimeType ?? fileStat.type;
    if (mimeType === undefined || mimeType === '') {
      throw new Error(
        'Can not determine mimeType. Please provide mimeType in the config.',
      );
    }
    fileToUpload.mimeType = mimeType;

    const uploadUrl = await this.fetchUploadUrl(fileToUpload, config);
    return uploader.upload(file, uploadUrl, this);
  }

  /**
   * Downloads a file asynchronously to the specified path.
   *
   * @params params - The parameters for the download request, see {@link
   * DownloadFileParameters}
   */
  async downloadFile(params: DownloadFileParameters): Promise<void> {
    const downloader = this.clientOptions.downloader;
    await downloader.download(params, this);
  }

  private async fetchUploadUrl(
    file: File,
    config?: UploadFileConfig,
  ): Promise<string> {
    let httpOptions: HttpOptions = {};
    if (config?.httpOptions) {
      httpOptions = config.httpOptions;
    } else {
      httpOptions = {
        apiVersion: '', // api-version is set in the path.
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': `${file.sizeBytes}`,
          'X-Goog-Upload-Header-Content-Type': `${file.mimeType}`,
        },
      };
    }

    const body: Record<string, File> = {
      'file': file,
    };
    const httpResponse = await this.request({
      path: common.formatMap(
        'upload/v1beta/files',
        body['_url'] as Record<string, unknown>,
      ),
      body: JSON.stringify(body),
      httpMethod: 'POST',
      httpOptions,
    });

    if (!httpResponse || !httpResponse?.headers) {
      throw new Error(
        'Server did not return an HttpResponse or the returned HttpResponse did not have headers.',
      );
    }

    const uploadUrl: string | undefined =
      httpResponse?.headers?.['x-goog-upload-url'];
    if (uploadUrl === undefined) {
      throw new Error(
        'Failed to get upload url. Server did not return the x-google-upload-url in the headers',
      );
    }
    return uploadUrl;
  }
}

async function throwErrorIfNotOK(response: Response | undefined) {
  if (response === undefined) {
    throw new Error('response is undefined');
  }
  if (!response.ok) {
    const status: number = response.status;
    let errorBody: Record<string, unknown>;
    if (response.headers.get('content-type')?.includes('application/json')) {
      errorBody = await response.json();
    } else {
      errorBody = {
        error: {
          message: await response.text(),
          code: response.status,
          status: response.statusText,
        },
      };
    }
    const errorMessage = JSON.stringify(errorBody);
    if (status >= 400 && status < 600) {
      const apiError = new ApiError({
        message: errorMessage,
        status: status,
      });
      throw apiError;
    }
    throw new Error(errorMessage);
  }
}

/**
 * Recursively updates the `requestInit.body` with values from an `extraBody` object.
 *
 * If `requestInit.body` is a string, it's assumed to be JSON and will be parsed.
 * The `extraBody` is then deeply merged into this parsed object.
 * If `requestInit.body` is a Blob, `extraBody` will be ignored, and a warning logged,
 * as merging structured data into an opaque Blob is not supported.
 *
 * The function does not enforce that updated values from `extraBody` have the
 * same type as existing values in `requestInit.body`. Type mismatches during
 * the merge will result in a warning, but the value from `extraBody` will overwrite
 * the original. `extraBody` users are responsible for ensuring `extraBody` has the correct structure.
 *
 * @param requestInit The RequestInit object whose body will be updated.
 * @param extraBody The object containing updates to be merged into `requestInit.body`.
 */
export function includeExtraBodyToRequestInit(
  requestInit: RequestInit,
  extraBody: Record<string, unknown>,
) {
  if (!extraBody || Object.keys(extraBody).length === 0) {
    return;
  }

  if (requestInit.body instanceof Blob) {
    console.warn(
      'includeExtraBodyToRequestInit: extraBody provided but current request body is a Blob. extraBody will be ignored as merging is not supported for Blob bodies.',
    );
    return;
  }

  let currentBodyObject: Record<string, unknown> = {};

  // If adding new type to HttpRequest.body, please check the code below to
  // see if we need to update the logic.
  if (typeof requestInit.body === 'string' && requestInit.body.length > 0) {
    try {
      const parsedBody = JSON.parse(requestInit.body);
      if (
        typeof parsedBody === 'object' &&
        parsedBody !== null &&
        !Array.isArray(parsedBody)
      ) {
        currentBodyObject = parsedBody as Record<string, unknown>;
      } else {
        console.warn(
          'includeExtraBodyToRequestInit: Original request body is valid JSON but not a non-array object. Skip applying extraBody to the request body.',
        );
        return;
      }
      /*  eslint-disable-next-line @typescript-eslint/no-unused-vars */
    } catch (e) {
      console.warn(
        'includeExtraBodyToRequestInit: Original request body is not valid JSON. Skip applying extraBody to the request body.',
      );
      return;
    }
  }

  function deepMerge(
    target: Record<string, unknown>,
    source: Record<string, unknown>,
  ): Record<string, unknown> {
    const output = {...target};
    for (const key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        const sourceValue = source[key];
        const targetValue = output[key];
        if (
          sourceValue &&
          typeof sourceValue === 'object' &&
          !Array.isArray(sourceValue) &&
          targetValue &&
          typeof targetValue === 'object' &&
          !Array.isArray(targetValue)
        ) {
          output[key] = deepMerge(
            targetValue as Record<string, unknown>,
            sourceValue as Record<string, unknown>,
          );
        } else {
          if (
            targetValue &&
            sourceValue &&
            typeof targetValue !== typeof sourceValue
          ) {
            console.warn(
              `includeExtraBodyToRequestInit:deepMerge: Type mismatch for key "${key}". Original type: ${typeof targetValue}, New type: ${typeof sourceValue}. Overwriting.`,
            );
          }
          output[key] = sourceValue;
        }
      }
    }
    return output;
  }

  const mergedBody = deepMerge(currentBodyObject, extraBody);
  requestInit.body = JSON.stringify(mergedBody);
}
