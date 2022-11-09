const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  timeTravelBlocks,
  beforeHook,
  beforeEachHook,
  forceHighMaxDebt,
  minimizeBondPeriod,
  forceFHMBondMinimumPositive,
  forceFHMBondNegative,
} = require("../../../utils/testUtils.ts");
const { addressBook } = require("blockchain-addressbook");
const {
  FHM,
  FHM_STAKER,
  STAKED_FHM,
  FHM_STAKE_MANAGER,
  BOGUS_ADDR_1,
  BOGUS_ADDR_2,
  TEST_TIMEOUT,
  FHM_DAI_BOND,
  SLOW_TEST_FLAG,
  FHM_DAI_ROUTE,
  FANTOHM_TEST_FLAG,
  FHM_WFTM_BOND,
  FHM_DAI_LP_BOND,
  FHM_BOND_CALCULATOR,
  FHM_WHALES,
  FHM_TREASURY,
} = require("../../../constants.js");

const { spookyswap } = addressBook.fantom.platforms;
const devAddress = BOGUS_ADDR_2;

const contractNames = {
  vault: "MinimumVault",
  strategy: "StrategyFantOHM",
};

const vaultConfig = {
  name: "Minimum FantOHM",
  symbol: "minFHM",
  stratApprovalDelay: 21600,
  wantCap: ethers.utils.parseUnits("6000", 9),
};

const stratConfig = {
  rebaseStaker: FHM_STAKER,
  stakeManager: FHM_STAKE_MANAGER,
  keeper: BOGUS_ADDR_1,
  unirouter: spookyswap.router,
  serviceFeeRecipient: devAddress,
  minDeposit: 100,
  discordLink: "https://discord.gg/fS5ZUwDtVK",
};

describe(FANTOHM_TEST_FLAG + " Strategy redeemAndStake", function () {
  let vault,
    strategy,
    unirouter,
    fhm,
    stakedFhm,
    deployer,
    keeper,
    other,
    whale,
    daiBondDepository,
    wftmBondDepository,
    fhmDaiBondDepository,
    stakeManager,
    stakingHelper,
    daiWftmPair,
    rebaseTokenBalStart,
    daiValueInitial,
    unirouterData;

  this.slow(20000);

  beforeEach(async () => {
    ({
      rebaseToken: fhm,
      stakedRebaseToken: stakedFhm,
      unirouter,
      unirouterData,
      whale,
      daiBondDepository,
      wftmBondDepository,
      daiLPBondDepository: fhmDaiBondDepository,
      daiWftmPair,
      stakeManager,
      stakingHelper,
    } = await beforeHook({
      provider: ethers.provider,
      stratConfig,
      rebaseTokenAddr: FHM,
      stakedRebaseTokenAddr: STAKED_FHM,
      daiBondAddr: FHM_DAI_BOND,
      wftmBondAddr: FHM_WFTM_BOND,
      daiLPBondAddr: FHM_DAI_LP_BOND,
      lpBondCalculatorAddr: FHM_BOND_CALCULATOR,
      stakeManagerAddr: FHM_STAKE_MANAGER,
      whales: FHM_WHALES,
      whaleToken: STAKED_FHM,
      treasuryAddr: FHM_TREASURY,
      fundStaked: true,
      stakingHelperAddr: FHM_STAKER,
    }));
    ({
      vault,
      strategy,
      rebaseTokenBalStart,
      daiValueInitial,
      deployer,
      keeper,
      other,
    } = await beforeEachHook({
      contractNames,
      vaultConfig,
      stratConfig,
      unirouter,
      rebaseToken: fhm,
      whale,
      stakedRebaseToken: stakedFhm,
      fundStaked: true,
    }));

    await forceHighMaxDebt(ethers.provider, daiBondDepository);
    await forceHighMaxDebt(ethers.provider, wftmBondDepository);
    await forceHighMaxDebt(ethers.provider, fhmDaiBondDepository);
  });

  it(
    SLOW_TEST_FLAG +
      "Redeems and stakes with a redeem fee (Positive | DAI Bond)",
    async function () {
      const fhmBalStart = await stakedFhm.balanceOf(deployer.address);
      const daiValueInitial = ethers.utils.formatEther(
        await strategy.rebaseTokenPriceInUSD(fhmBalStart)
      );

      await vault.depositAll();

      await strategy.addBond(FHM_DAI_BOND);
      await strategy.stakeToBondSingleAll(FHM_DAI_BOND, FHM_DAI_ROUTE);

      expect(await strategy.isBonding()).to.be.true;

      const feeRate = await strategy.serviceFee();
      const feeDivisor = await strategy.SERVICE_FEE_DIVISOR();

      const bondDetailsInitial = await daiBondDepository.bondInfo(
        strategy.address
      );
      const pricePaid = ethers.utils.formatUnits(
        bondDetailsInitial.pricePaid,
        18
      );
      const payoutInitial = bondDetailsInitial.payout;
      const payoutPerRebasePeriod = payoutInitial.div(15);
      const parsedPayoutInitial = parseFloat(
        ethers.utils.formatUnits(payoutInitial, 9)
      );
      const calculatedPayout = parseFloat(daiValueInitial / pricePaid);

      // Should expect calculated to be a bit more as fee takes away some value
      // when swapping FHM for the bond
      expect(parsedPayoutInitial).to.lte(calculatedPayout);
      expect(parsedPayoutInitial).to.gt(calculatedPayout * 0.99);

      // Expect pending payout to be 0
      expect(
        await daiBondDepository.pendingPayoutFor(strategy.address)
      ).to.equal(0);

      // Now let 1 rebase period go by
      await timeTravelBlocks(
        ethers.provider,
        parseInt(
          ethers.utils.formatUnits(bondDetailsInitial.vesting.div(15), 0)
        )
      );
      // Trigger rebase as to not corroborate our results.
      await stakeManager.rebase();

      const devBalInitial = await stakedFhm.balanceOf(devAddress);

      //Expect there to be no FHM or sFHM in strat before redeem
      expect(await strategy.totalRebasing()).to.equal(0);
      expect(await fhm.balanceOf(strategy.address)).to.equal(0);
      expect(await stakedFhm.balanceOf(strategy.address)).to.equal(0);

      let pendingPayout = await daiBondDepository.pendingPayoutFor(
        strategy.address
      ); // Notice goes one more block when redeeming

      // Expect pending payout to be {payoutPerRebasePeriod}, notice inaccuracy due to division truncation
      expect(pendingPayout).to.lte(payoutPerRebasePeriod);
      expect(pendingPayout).to.gt(payoutPerRebasePeriod.mul(99).div(100));

      const unstaked = await strategy.unstakedRebasing();
      const staked = (await strategy.stakedRebasing()).add(pendingPayout);
      const warmup = 0;
      const bonded = (await strategy.rebaseBonded()).sub(pendingPayout);
      const totalBalance = await vault.balance();

      await expect(strategy.redeemAndStake())
        .to.emit(strategy, "Redeem")
        .withArgs(unstaked, staked, warmup, bonded, totalBalance);

      let stakedFhmBal = await stakedFhm.balanceOf(strategy.address);

      // Expect all redeemed (- fee) to be staked
      expect(await strategy.totalRebasing()).to.equal(pendingPayout);
      expect(await fhm.balanceOf(strategy.address)).to.equal(0);
      expect(stakedFhmBal).to.equal(pendingPayout);
      expect(stakedFhmBal).to.be.gt(0);

      let devBal = (await stakeManager.warmupInfo(devAddress)).deposit;

      let bondDetails = await daiBondDepository.bondInfo(strategy.address);

      expect(bondDetails.payout).to.equal(payoutInitial.sub(pendingPayout));

      // Travel 2 more rebase periods
      await timeTravelBlocks(
        ethers.provider,
        parseInt(
          ethers.utils.formatUnits(bondDetailsInitial.vesting.mul(2).div(15), 0)
        )
      );
      // Trigger rebase as to not corroborate our results.
      await stakeManager.rebase();
      await stakeManager.rebase();

      pendingPayout = await daiBondDepository.pendingPayoutFor(
        strategy.address
      );

      // Expect pending payout to be 2x{payoutPerRebasePeriod}, notice innaccuracy due to division truncation
      expect(pendingPayout).to.lte(payoutPerRebasePeriod.mul(2));
      expect(pendingPayout).to.gt(payoutPerRebasePeriod.mul(198).div(100));

      let stratBalBeforeRedeem = await stakedFhm.balanceOf(strategy.address);

      await strategy.redeemAndStake();

      expect(await strategy.totalRebasing()).to.equal(
        pendingPayout.add(stratBalBeforeRedeem)
      );
      expect(await fhm.balanceOf(strategy.address)).to.equal(0);
      expect(await stakedFhm.balanceOf(strategy.address)).to.equal(
        pendingPayout.add(stratBalBeforeRedeem)
      );
    }
  ).timeout(TEST_TIMEOUT * 2);
});
