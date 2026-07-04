export function parsePlanDescription(description) {
  const price = description.match(/(\d+(?:\.\d+)?)\s*(元|块|rmb|￥)/i)?.[1];
  const data = description.match(/(\d+(?:\.\d+)?)\s*(g|gb|G|GB)/)?.[1];

  return {
    dataGb: data ? Number(data) : null,
    price: price ? Number(price) : null,
  };
}

export function recommendPlansFromDescription(description, plans, limit = 3) {
  const currentPlan = parsePlanDescription(description);

  return plans
    .filter((plan) => {
      const cheaper = currentPlan.price === null || plan.price <= currentPlan.price;
      const moreData = currentPlan.dataGb === null || plan.data > currentPlan.dataGb;
      return cheaper && moreData;
    })
    .sort((a, b) => a.price - b.price || b.data - a.data)
    .slice(0, limit);
}
