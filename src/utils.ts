import fs from "fs";
import path from "path";

// https://stackoverflow.com/a/55743632/2410292
export const filterObjectByKeys = (object: any, keysToFilter: string[]) => {
  return Object.keys(object).reduce((accum, key) => {
    if (!keysToFilter.includes(key)) {
      return { ...accum, [key]: object[key] };
    } else {
      return accum;
    }
  }, {});
};

// https://brianchildress.co/find-latest-file-in-directory-in-nodejs/
export const orderRecentFiles = (dir: string) => {
  return fs
    .readdirSync(dir)
    .filter((file) => fs.lstatSync(path.join(dir, file)).isFile())
    .map((file) => ({ file, mtime: fs.lstatSync(path.join(dir, file)).mtime }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
};
