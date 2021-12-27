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
